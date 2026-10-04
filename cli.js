#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TICKET_ALPHABET, TICKET_STATES, TICKET_TYPES } from "./src/ticket.js";

const HELP = `viewmark talks to the document hub, one command, then exit.

Usage:
  viewmark [--port PORT] [--user NAME] [--json] list
  viewmark [--port PORT] [--user NAME] [--json] show <path>
  viewmark [--port PORT] [--user NAME] [--json] create <path>
  viewmark [--port PORT] [--user NAME] [--json] edit <path> --rev N --find TEXT --replace TEXT
  viewmark [--port PORT] [--user NAME] [--json] ticket list [--closed]
  viewmark [--port PORT] [--user NAME] [--json] ticket show <id>
  viewmark [--port PORT] [--user NAME] [--json] ticket create --title TEXT [--state STATE] [--type TYPE]
  viewmark [--port PORT] [--user NAME] [--json] ticket set <id> --rev N [--title TEXT] [--state STATE] [--type TYPE] [--parent ID] [--depends IDS]
  viewmark [--port PORT] [--user NAME] [--json] ticket purge
  viewmark help [cmd]
  viewmark --help

--port or VIEWMARK_PORT, default 8765. --user or VIEWMARK_USER; the flag wins.
Missing, empty, NUL, CR, LF, <, or > is rejected. There is no default name.
--json is global. --help, help, or no args exits 0.

stdout and stderr:
  list: one path per line on stdout
  show: the document text on stdout and rev N on stderr
  create: path on stdout and rev 0 on stderr
  edit: one copy-paste edit, then the same stdout and stderr as show
  stale or later conflict: the held text on stdout and rev N plus conflict on stderr
  match count other than one: matches N on stderr
  other statuses: error STATUS on stderr
  --json: one object plus a newline and empty stderr:
    list {files}; show and edit {path,rev,text}; create {path,rev:0};
    conflict {path,rev,text,error:"conflict"}

Example of one copy-paste edit:
  viewmark --user alice edit hello.md --rev 0 --find "hello" --replace "hi"

ticket:
  list [--closed], show <id>, create --title TEXT [--state STATE] [--type TYPE], set <id> --rev N, purge.
  --rev, --title, --state, --type, --parent, --depends, --closed.
  --parent none clears. --depends none clears. --state is new, triaged, in progress, or closed.
  --type is bug, enhancement, or task. An omitted type is task.
  reporter is --user. A stale rev exits 409 and does not write.
  list prints id, created, state, type, and title. show prints the body.
  --json: list {tickets:[{id,title,state,type,parent,depends,reporter,created}]};
    show and set {id,path,rev,title,state,type,parent,depends,reporter,created,text};
    create {id,path,rev:0,reporter,created}; purge {purged:[...]};
    conflict adds "error":"conflict".

Exit codes: 0, 1, 2, 400, 404, 409.
  0 success, help, or find equal to replace
  1 five silent seconds or a dead socket
  2 usage
  400, 404, 409 hub status
A stale rev exits 409 and does not write. The shell status is that number modulo 256, so 400 is 144, 404 is 148, and 409 is 153. stderr \`conflict\` or \`error N\` is the hub status.
`;

const VALUE_FLAGS = new Set(["port", "user", "rev", "find", "replace", "title", "state", "type", "parent", "depends"]);

// Same rejection the hub uses, so a bad name never opens a socket.
export function validUsername(name) {
  return typeof name === "string" && name.length > 0 && !/[\0\r\n<>]/.test(name);
}

function normalizeCreate(input) {
  const trimmed = String(input ?? "").trim().replace(/^\/+/, "");
  if (!trimmed) return "";
  if (trimmed.endsWith(".md") || trimmed.endsWith(".markdown")) return trimmed;
  return `${trimmed}.md`;
}

function usage(message) {
  process.stderr.write(`viewmark: ${message}\n`);
  process.exitCode = 2;
}

function help() {
  process.stdout.write(HELP);
  process.exitCode = 0;
}

function parseArgs(argv) {
  const args = {
    help: false,
    json: false,
    portSet: false,
    port: "",
    userSet: false,
    user: "",
    revSet: false,
    rev: "",
    findSet: false,
    find: "",
    replaceSet: false,
    replace: "",
    titleSet: false,
    title: "",
    stateSet: false,
    state: "",
    typeSet: false,
    type: "",
    parentSet: false,
    parent: "",
    dependsSet: false,
    depends: "",
    closed: false,
    positionals: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      args.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--closed") {
      args.closed = true;
      continue;
    }
    if (arg.startsWith("--")) {
      let name = arg.slice(2);
      let value;
      const eq = name.indexOf("=");
      if (eq !== -1) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      if (!VALUE_FLAGS.has(name)) return null;
      if (eq === -1) {
        i += 1;
        if (i >= argv.length) return null;
        value = argv[i];
      }
      if (name === "port") {
        args.portSet = true;
        args.port = value;
      } else if (name === "user") {
        args.userSet = true;
        args.user = value;
      } else if (name === "rev") {
        args.revSet = true;
        args.rev = value;
      } else if (name === "find") {
        args.findSet = true;
        args.find = value;
      } else if (name === "replace") {
        args.replaceSet = true;
        args.replace = value;
      } else if (name === "title") {
        args.titleSet = true;
        args.title = value;
      } else if (name === "state") {
        args.stateSet = true;
        args.state = value;
      } else if (name === "type") {
        args.typeSet = true;
        args.type = value;
      } else if (name === "parent") {
        args.parentSet = true;
        args.parent = value;
      } else if (name === "depends") {
        args.dependsSet = true;
        args.depends = value;
      }
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") return null;
    args.positionals.push(arg);
  }
  return args;
}

function parsePort(raw) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (n < 0 || n > 65535) return null;
  return n;
}

function parseRev(raw) {
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

function lineSpans(doc) {
  const lines = [];
  let start = 0;
  for (let i = 0; i <= doc.length; i += 1) {
    if (i === doc.length || doc[i] === "\n") {
      lines.push({ start, end: i });
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

// Lock the same inclusive endpoints the hub turns into held lines.
function touchedLines(doc, from, to) {
  const start = lineIndexAt(doc, from);
  const end = lineIndexAt(doc, to);
  const lines = [];
  for (let index = Math.min(start, end); index <= Math.max(start, end); index += 1) lines.push(index);
  return lines;
}

function findHits(text, needle) {
  const hits = [];
  let from = 0;
  while (from <= text.length - needle.length) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    hits.push(at);
    from = at + needle.length;
  }
  return hits;
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function printShow(doc, json) {
  if (json) {
    writeJson({ path: doc.path, rev: doc.rev, text: doc.text });
    return;
  }
  process.stdout.write(doc.text);
  process.stderr.write(`rev ${doc.rev}\n`);
}

function printConflict(doc, json) {
  if (json) {
    writeJson({ path: doc.path, rev: doc.rev, text: doc.text, error: "conflict" });
    return;
  }
  process.stdout.write(doc.text);
  process.stderr.write(`rev ${doc.rev}\nconflict\n`);
}

function statusOf(msg) {
  return msg && typeof msg.status === "number" ? msg.status : null;
}

function payloadText(data) {
  if (typeof data === "string") return Promise.resolve(data);
  if (Buffer.isBuffer(data)) return Promise.resolve(data.toString("utf8"));
  if (data instanceof ArrayBuffer) return Promise.resolve(Buffer.from(data).toString("utf8"));
  if (ArrayBuffer.isView(data)) {
    return Promise.resolve(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8"));
  }
  if (data && typeof data.text === "function") return data.text();
  return Promise.reject(1);
}

function connectHub(port, username) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
  const inbox = [];
  let waiter = null;
  let finished = false;
  let silence = null;
  let readyReject = null;

  function arm() {
    clearTimeout(silence);
    silence = setTimeout(() => finish(1), 5000);
  }

  function kick() {
    if (!waiter) return;
    const index = inbox.findIndex(waiter.pred);
    if (index < 0) return;
    const msg = inbox.splice(index, 1)[0];
    const pending = waiter;
    waiter = null;
    pending.resolve(msg);
  }

  function next(pred) {
    if (finished) return Promise.reject(1);
    return new Promise((resolve, reject) => {
      waiter = { pred, resolve, reject };
      kick();
    });
  }

  function send(obj) {
    ws.send(JSON.stringify(obj));
  }

  const ready = new Promise((resolve, reject) => {
    readyReject = reject;
    ws.addEventListener("open", () => {
      if (finished) return;
      readyReject = null;
      send({ type: "hello", username });
      resolve();
    });
  });

  function finish(code) {
    if (finished) return;
    finished = true;
    clearTimeout(silence);
    if (waiter) {
      const pending = waiter;
      waiter = null;
      pending.reject(code);
    }
    if (readyReject) {
      const reject = readyReject;
      readyReject = null;
      reject(code);
    }
    const exit = () => {
      process.exitCode = code;
      process.exit(code);
    };
    if (ws.readyState === WebSocket.CLOSED) {
      exit();
      return;
    }
    // The hub commits a dirty path from the disconnect handler.
    const backup = setTimeout(exit, 1000);
    ws.addEventListener("close", () => {
      clearTimeout(backup);
      exit();
    });
    try {
      ws.close();
    } catch {
      clearTimeout(backup);
      exit();
    }
  }

  arm();
  ws.addEventListener("error", () => finish(1));
  ws.addEventListener("close", () => finish(1));
  let chain = Promise.resolve();
  ws.addEventListener("message", (ev) => {
    chain = chain.then(() => payloadText(ev.data)).then((text) => {
      if (finished) return;
      arm();
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        finish(1);
        return;
      }
      if (!msg || typeof msg !== "object") {
        finish(1);
        return;
      }
      if (msg.type === "ping") {
        send({ type: "pong", username });
        return;
      }
      inbox.push(msg);
      kick();
    }).catch(() => finish(1));
  });

  return { ready, send, next, finish };
}

function serverError(msg) {
  const status = statusOf(msg);
  if (status === null) return 1;
  process.stderr.write(`error ${status}\n`);
  return status;
}

function asDoc(msg) {
  if (!msg || typeof msg.path !== "string" || typeof msg.rev !== "number" || typeof msg.text !== "string") return null;
  return { path: msg.path, rev: msg.rev, text: msg.text };
}

function holds(msg, username, path, lines) {
  if (!msg || msg.type !== "locks" || msg.path !== path || !Array.isArray(msg.lines)) return false;
  const owned = new Set();
  for (const line of msg.lines) {
    if (line && line.username === username && Number.isInteger(line.index)) owned.add(line.index);
  }
  return lines.every((index) => owned.has(index));
}

async function runList(hub, username, json) {
  hub.send({ type: "list", username });
  const msg = await hub.next((item) => item.type === "docs" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  if (!Array.isArray(msg.files) || msg.files.some((file) => typeof file !== "string")) return 1;
  if (json) {
    writeJson({ files: msg.files });
    return 0;
  }
  if (msg.files.length > 0) process.stdout.write(msg.files.map((file) => `${file}\n`).join(""));
  return 0;
}

async function runShow(hub, username, path, json) {
  hub.send({ type: "open", username, path });
  const msg = await hub.next((item) => item.type === "file" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  const doc = asDoc(msg);
  if (!doc) return 1;
  printShow(doc, json);
  return 0;
}

async function runCreate(hub, username, path, json) {
  hub.send({ type: "create", username, path });
  const msg = await hub.next((item) => item.type === "file" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  const doc = asDoc(msg);
  if (!doc) return 1;
  if (json) {
    writeJson({ path: doc.path, rev: doc.rev });
    return 0;
  }
  process.stdout.write(`${doc.path}\n`);
  process.stderr.write(`rev ${doc.rev}\n`);
  return 0;
}

async function runEdit(hub, username, path, rev, find, replace, json) {
  hub.send({ type: "open", username, path });
  const opened = await hub.next((item) => item.type === "file" || item.type === "error");
  if (opened.type === "error") return serverError(opened);
  const held = asDoc(opened);
  if (!held) return 1;
  if (held.rev !== rev) return printConflict(held, json), 409;
  const hits = findHits(held.text, find);
  if (hits.length !== 1) {
    process.stderr.write(`matches ${hits.length}\n`);
    return 2;
  }
  if (find === replace) {
    printShow(held, json);
    return 0;
  }
  const anchor = hits[0];
  const cursor = anchor + find.length;
  const lines = touchedLines(held.text, anchor, cursor);
  hub.send({ type: "lock", username, path: held.path, rev: held.rev, anchor, cursor });
  // publish refuses an edit until this socket holds every touched line.
  const locked = await hub.next((item) => item.type === "error" || holds(item, username, held.path, lines));
  if (locked.type === "error") {
    if (locked.status === 409) return printConflict(held, json), 409;
    return serverError(locked);
  }
  hub.send({ type: "edit", username, path: held.path, rev: held.rev, op: "insert", text: replace });
  const edited = await hub.next((item) => item.type === "doc" || item.type === "error");
  if (edited.type === "error") {
    if (edited.status === 409) return printConflict(held, json), 409;
    return serverError(edited);
  }
  const doc = asDoc(edited);
  if (!doc) return 1;
  printShow(doc, json);
  return 0;
}

function validTicketId(id) {
  if (typeof id !== "string" || id.length !== 8) return false;
  for (let i = 0; i < id.length; i += 1) {
    if (!TICKET_ALPHABET.includes(id[i])) return false;
  }
  return true;
}

function normalizeTitle(raw) {
  if (typeof raw !== "string") return null;
  const title = raw.trim();
  if (title.length === 0) return null;
  return title;
}

function normalizeParent(raw) {
  if (raw === "none") return "";
  if (!validTicketId(raw)) return null;
  return raw;
}

function normalizeDepends(raw) {
  if (raw === "none") return [];
  const ids = [];
  const seen = new Set();
  for (const part of String(raw).split(",")) {
    const id = part.trim();
    if (!validTicketId(id)) return null;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  ids.sort();
  return ids;
}

function prepareTicket(args, rest) {
  const [sub, ...more] = rest;
  if (sub === "list") {
    if (more.length !== 0) return { error: "unexpected argument" };
    return { sub };
  }
  if (sub === "show") {
    if (more.length === 0) return { error: "id required" };
    if (more.length !== 1) return { error: "unexpected argument" };
    if (!validTicketId(more[0])) return { error: "invalid id" };
    return { sub, id: more[0] };
  }
  if (sub === "create") {
    if (more.length !== 0) return { error: "unexpected argument" };
    if (!args.titleSet) return { error: "empty title" };
    const title = normalizeTitle(args.title);
    if (title === null) return { error: "empty title" };
    const command = { sub, title };
    if (args.stateSet) {
      if (!TICKET_STATES.includes(args.state)) return { error: "invalid state" };
      command.state = args.state;
    }
    if (args.typeSet) {
      if (!TICKET_TYPES.includes(args.type)) return { error: "invalid type" };
      command.type = args.type;
    }
    return command;
  }
  if (sub === "set") {
    if (more.length === 0) return { error: "id required" };
    if (more.length !== 1) return { error: "unexpected argument" };
    if (!validTicketId(more[0])) return { error: "invalid id" };
    if (!args.revSet) return { error: "set requires integer --rev" };
    const rev = parseRev(args.rev);
    if (rev === null) return { error: "set requires integer --rev" };
    const fields = {};
    if (args.titleSet) {
      const title = normalizeTitle(args.title);
      if (title === null) return { error: "empty title" };
      fields.title = title;
    }
    if (args.stateSet) {
      if (!TICKET_STATES.includes(args.state)) return { error: "invalid state" };
      fields.state = args.state;
    }
    if (args.typeSet) {
      if (!TICKET_TYPES.includes(args.type)) return { error: "invalid type" };
      fields.type = args.type;
    }
    if (args.parentSet) {
      const parent = normalizeParent(args.parent);
      if (parent === null) return { error: "invalid id" };
      fields.parent = parent;
    }
    if (args.dependsSet) {
      const depends = normalizeDepends(args.depends);
      if (depends === null) return { error: "invalid id" };
      fields.depends = depends;
    }
    if (Object.keys(fields).length === 0) return { error: "set requires --title, --state, --type, --parent, or --depends" };
    return { sub, id: more[0], rev, fields };
  }
  if (sub === "purge") {
    if (more.length !== 0) return { error: "unexpected argument" };
    return { sub };
  }
  return { error: "unknown command" };
}

function asTicket(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!validTicketId(raw.id)) return null;
  if (typeof raw.title !== "string" || typeof raw.state !== "string") return null;
  if (!TICKET_TYPES.includes(raw.type)) return null;
  if (typeof raw.parent !== "string" || (raw.parent !== "" && !validTicketId(raw.parent))) return null;
  if (!Array.isArray(raw.depends) || raw.depends.some((id) => !validTicketId(id))) return null;
  if (typeof raw.reporter !== "string" || typeof raw.created !== "string") return null;
  return {
    id: raw.id,
    title: raw.title,
    state: raw.state,
    type: raw.type,
    parent: raw.parent,
    depends: raw.depends.slice(),
    reporter: raw.reporter,
    created: raw.created,
  };
}

function asTicketList(msg) {
  if (!msg || !Array.isArray(msg.tickets)) return null;
  const tickets = [];
  for (const raw of msg.tickets) {
    const ticket = asTicket(raw);
    if (!ticket) return null;
    tickets.push(ticket);
  }
  return tickets;
}

function asTicketNotice(msg, id) {
  if (!msg || typeof msg !== "object") return null;
  if (typeof msg.title !== "string" || typeof msg.state !== "string") return null;
  if (!TICKET_TYPES.includes(msg.ticketType)) return null;
  if (typeof msg.parent !== "string" || (msg.parent !== "" && !validTicketId(msg.parent))) return null;
  if (!Array.isArray(msg.depends) || msg.depends.some((dep) => !validTicketId(dep))) return null;
  if (typeof msg.reporter !== "string" || typeof msg.created !== "string") return null;
  if (typeof msg.rev !== "number") return null;
  return {
    id,
    title: msg.title,
    state: msg.state,
    type: msg.ticketType,
    parent: msg.parent,
    depends: msg.depends.slice(),
    reporter: msg.reporter,
    created: msg.created,
    rev: msg.rev,
  };
}

function asTicketFile(msg) {
  const doc = asDoc(msg);
  if (!doc) return null;
  const ticket = asTicket(msg.ticket);
  if (!ticket) return null;
  return { ...ticket, path: doc.path, rev: doc.rev, text: doc.text };
}

function metaLine(label, value) {
  return value === "" ? label : `${label} ${value}`;
}

function ticketMeta(view) {
  const lines = [
    `rev ${view.rev}`,
    metaLine("title", view.title),
    metaLine("state", view.state),
    metaLine("type", view.type),
    metaLine("parent", view.parent),
    metaLine("depends", view.depends.join(",")),
    metaLine("reporter", view.reporter),
    metaLine("created", view.created),
  ];
  return `${lines.join("\n")}\n`;
}

function printTicket(view, json, conflict) {
  if (json) {
    const payload = {
      id: view.id,
      path: view.path,
      rev: view.rev,
      title: view.title,
      state: view.state,
      type: view.type,
      parent: view.parent,
      depends: view.depends,
      reporter: view.reporter,
      created: view.created,
      text: view.text,
    };
    if (conflict) payload.error = "conflict";
    writeJson(payload);
    return;
  }
  process.stdout.write(view.text);
  process.stderr.write(ticketMeta(view));
  if (conflict) process.stderr.write("conflict\n");
}

function sameDepends(stored, requested) {
  const left = [...new Set(stored)].sort();
  if (left.length !== requested.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== requested[i]) return false;
  }
  return true;
}

function requestedMatches(opened, fields) {
  if (Object.prototype.hasOwnProperty.call(fields, "title") && fields.title !== opened.title) return false;
  if (Object.prototype.hasOwnProperty.call(fields, "state") && fields.state !== opened.state) return false;
  if (Object.prototype.hasOwnProperty.call(fields, "type") && fields.type !== opened.type) return false;
  if (Object.prototype.hasOwnProperty.call(fields, "parent") && fields.parent !== opened.parent) return false;
  if (Object.prototype.hasOwnProperty.call(fields, "depends") && !sameDepends(opened.depends, fields.depends)) return false;
  return true;
}

function printTicketList(tickets, json) {
  if (json) {
    writeJson({
      tickets: tickets.map((ticket) => ({
        id: ticket.id,
        title: ticket.title,
        state: ticket.state,
        type: ticket.type,
        parent: ticket.parent,
        depends: ticket.depends,
        reporter: ticket.reporter,
        created: ticket.created,
      })),
    });
    return;
  }
  if (tickets.length === 0) return;
  process.stdout.write(tickets.map((ticket) => (
    `${ticket.id}\t${ticket.created}\t${ticket.state}\t${ticket.type}\t${ticket.title}\n`
  )).join(""));
}

async function runTicketList(hub, username, json, includeClosed) {
  hub.send({ type: "tickets", username });
  const msg = await hub.next((item) => item.type === "tickets" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  const tickets = asTicketList(msg);
  if (!tickets) return 1;
  const visible = includeClosed ? tickets : tickets.filter((ticket) => ticket.state !== "closed");
  printTicketList(visible, json);
  return 0;
}

async function runTicketShow(hub, username, id, json) {
  hub.send({ type: "open", username, path: `tickets/${id}.md` });
  const msg = await hub.next((item) => item.type === "file" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  const view = asTicketFile(msg);
  if (!view) return 1;
  printTicket(view, json, false);
  return 0;
}

async function runTicketCreate(hub, username, command, json) {
  const payload = { type: "ticket.create", username, title: command.title };
  if (command.state !== undefined) payload.state = command.state;
  if (command.type !== undefined) payload.ticketType = command.type;
  hub.send(payload);
  const msg = await hub.next((item) => item.type === "file" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  const view = asTicketFile(msg);
  if (!view) return 1;
  if (json) {
    writeJson({
      id: view.id,
      path: view.path,
      rev: view.rev,
      reporter: view.reporter,
      created: view.created,
    });
    return 0;
  }
  process.stdout.write(`${view.id}\n`);
  process.stderr.write(`rev ${view.rev}\n${metaLine("reporter", view.reporter)}\n${metaLine("created", view.created)}\n`);
  return 0;
}

async function runTicketSet(hub, username, command, json) {
  const path = `tickets/${command.id}.md`;
  // Ticket frames go only to subscribers, so open before set.
  hub.send({ type: "open", username, path });
  const openedMsg = await hub.next((item) => item.type === "file" || item.type === "error");
  if (openedMsg.type === "error") return serverError(openedMsg);
  const opened = asTicketFile(openedMsg);
  if (!opened) return 1;
  // A mismatched rev is a conflict. Do not send: the hub reports a bad field
  // as 400 before it compares rev.
  if (opened.rev !== command.rev) return printTicket(opened, json, true), 409;
  // The hub stays silent when the composed ticket would not change.
  if (requestedMatches(opened, command.fields)) return printTicket(opened, json, false), 0;
  const payload = {
    type: "ticket.set",
    username,
    path: opened.path,
    rev: command.rev,
  };
  const fields = command.fields;
  if (Object.prototype.hasOwnProperty.call(fields, "title")) payload.title = fields.title;
  if (Object.prototype.hasOwnProperty.call(fields, "state")) payload.state = fields.state;
  if (Object.prototype.hasOwnProperty.call(fields, "parent")) payload.parent = fields.parent;
  if (Object.prototype.hasOwnProperty.call(fields, "depends")) payload.depends = fields.depends;
  if (Object.prototype.hasOwnProperty.call(fields, "type")) payload.ticketType = fields.type;
  hub.send(payload);
  const msg = await hub.next((item) => item.type === "error" || (item.type === "ticket" && item.path === opened.path));
  if (msg.type === "error") {
    if (msg.status === 409) return printTicket(opened, json, true), 409;
    return serverError(msg);
  }
  const next = asTicketNotice(msg, opened.id);
  if (!next) return 1;
  printTicket({ ...next, path: opened.path, text: opened.text }, json, false);
  return 0;
}

async function runTicketPurge(hub, username, json) {
  hub.send({ type: "tickets", username });
  const before = await hub.next((item) => item.type === "tickets" || item.type === "error");
  if (before.type === "error") return serverError(before);
  const prior = asTicketList(before);
  if (!prior) return 1;
  hub.send({ type: "ticket.purge", username });
  const after = await hub.next((item) => item.type === "tickets" || item.type === "error");
  if (after.type === "error") return serverError(after);
  const left = asTicketList(after);
  if (!left) return 1;
  const remain = new Set(left.map((ticket) => ticket.id));
  const purged = prior
    .filter((ticket) => ticket.state === "closed" && !remain.has(ticket.id))
    .map((ticket) => ticket.id);
  if (json) {
    writeJson({ purged });
    return 0;
  }
  if (purged.length > 0) process.stdout.write(purged.map((id) => `${id}\n`).join(""));
  return 0;
}

async function runTicket(hub, username, args, command) {
  if (command.sub === "list") return runTicketList(hub, username, args.json, args.closed);
  if (command.sub === "show") return runTicketShow(hub, username, command.id, args.json);
  if (command.sub === "create") return runTicketCreate(hub, username, command, args.json);
  if (command.sub === "set") return runTicketSet(hub, username, command, args.json);
  if (command.sub === "purge") return runTicketPurge(hub, username, args.json);
  return 2;
}

async function withHub(port, username, fn) {
  const hub = connectHub(port, username);
  try {
    await hub.ready;
    const code = await fn(hub);
    hub.finish(code);
  } catch (err) {
    hub.finish(typeof err === "number" ? err : 1);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    usage("unknown argument");
    return;
  }
  const [cmd, ...rest] = args.positionals;
  if (args.help || cmd === undefined || cmd === "help") {
    if (cmd === "help" && rest.length > 1) {
      usage("unexpected argument");
      return;
    }
    help();
    return;
  }

  const user = args.userSet ? args.user : process.env.VIEWMARK_USER;
  if (user === undefined) {
    usage("username required");
    return;
  }
  if (!validUsername(user)) {
    usage("invalid username");
    return;
  }

  const port = parsePort(args.portSet ? args.port : (process.env.VIEWMARK_PORT ?? "8765"));
  if (port === null) {
    usage("invalid port");
    return;
  }

  if (cmd === "list") {
    if (rest.length !== 0) {
      usage("unexpected argument");
      return;
    }
    await withHub(port, user, (hub) => runList(hub, user, args.json));
    return;
  }
  if (cmd === "ticket") {
    const command = prepareTicket(args, rest);
    if (command.error) {
      usage(command.error);
      return;
    }
    await withHub(port, user, (hub) => runTicket(hub, user, args, command));
    return;
  }
  if (cmd !== "show" && cmd !== "create" && cmd !== "edit") {
    usage("unknown command");
    return;
  }
  if (rest.length === 0) {
    usage("path required");
    return;
  }
  if (rest.length !== 1) {
    usage("unexpected argument");
    return;
  }

  if (cmd === "show") {
    await withHub(port, user, (hub) => runShow(hub, user, rest[0], args.json));
    return;
  }
  if (cmd === "create") {
    const path = normalizeCreate(rest[0]);
    if (!path) {
      usage("empty path");
      return;
    }
    await withHub(port, user, (hub) => runCreate(hub, user, path, args.json));
    return;
  }

  if (!args.revSet || !args.findSet || !args.replaceSet) {
    usage("edit requires integer --rev, non-empty --find, and --replace");
    return;
  }
  const rev = parseRev(args.rev);
  if (rev === null || args.find.length === 0) {
    usage("edit requires integer --rev, non-empty --find, and --replace");
    return;
  }
  await withHub(port, user, (hub) => runEdit(hub, user, rest[0], rev, args.find, args.replace, args.json));
}

const entry = process.argv[1];
if (entry) {
  let direct = false;
  try {
    direct = realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    direct = false;
  }
  if (direct) {
    main().catch(() => {
      process.exitCode = 1;
      process.exit(1);
    });
  }
}
