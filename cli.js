#!/usr/bin/env node

import { realpathSync, writeSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "./server.js";
import { lockIndexAt } from "./src/doc.js";
import { TICKET_ALPHABET, TICKET_PRIORITIES, TICKET_STATES, TICKET_TYPES } from "./src/ticket.js";

const HELP = `viewmark talks to the document hub, one command, then exit.

Usage:
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME list
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME show <path>
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME create <path> [--file PATH]
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME edit <path> --rev N --find TEXT --replace TEXT
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME delete <path>
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME comment list <path>
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME comment show <path> <thread>
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME comment reply <path> <thread>
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME comment edit <path> <thread> <note> --rev N
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME commit [--message TEXT]
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME ticket list [--closed]
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME ticket show <id>
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME ticket create --title TEXT [--state STATE] [--type TYPE] [--priority PRIORITY]
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME ticket set <id> --rev N [--title TEXT] [--state STATE] [--type TYPE] [--priority PRIORITY] [--parent ID] [--depends IDS]
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME ticket delete <id>
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME ticket purge
  viewmark [--port PORT] [--user NAME] [--json] repo list
  viewmark [--port PORT] [--user NAME] [--json] repo register --name NAME --description TEXT --path PATH
  viewmark [--port PORT] [--user NAME] [--json] repo deregister <name>
  viewmark [--port PORT] serve [DIR]
  viewmark help [cmd]
  viewmark --help

--port or VIEWMARK_PORT, default 8765. --user or VIEWMARK_USER; the flag wins.
Missing, empty, NUL, CR, LF, <, or > is rejected. There is no default name.
--json is global. --help, help, or no args exits 0.
--repo is required on list, show, create, edit, delete, comment, commit, and ticket.
serve keeps running. The default directory is \`state\` beside the program, and --user is not required.

stdout and stderr:
  list: one path per line on stdout
  show: the document text on stdout and rev N on stderr
  create: path on stdout and rev 0 on stderr
  edit: one copy-paste edit, then the same stdout and stderr as show
  commit: the subject on stdout, or nothing when commits is empty. stderr is empty.
  stale or later conflict: the held text on stdout and rev N plus conflict on stderr
  match count other than one: matches N on stderr
  other statuses: error STATUS on stderr
  --json: one object plus a newline and empty stderr:
    list {files}; show and edit {path,rev,text}; create {path,rev:0};
    conflict {path,rev,text,error:"conflict"};
    commit {type:"commit",commits:[{author,subject,paths}]}
  repo list: name, description, and path, tab-separated, in name order
  repo register: the name
  repo deregister: nothing
  --json repo list {repos}; register {name,description,path}; deregister {name}

Example of one copy-paste edit:
  viewmark --user alice --repo docs edit hello.md --rev 0 --find "hello" --replace "hi"

create:
  The body is stdin when stdin is not a terminal. A terminal sends an empty body. --file PATH reads that file instead and does not read stdin.

commit:
  --message TEXT is optional. An omitted message lets the hub choose the subject.
  The message is trimmed and must be 1–200 characters. CR, LF, tab, and NUL are rejected.

ticket:
  list [--closed], show <id>, create --title TEXT [--state STATE] [--type TYPE] [--priority PRIORITY], set <id> --rev N, delete <id>, purge.
  --rev, --title, --state, --type, --priority, --parent, --depends, --closed.
  --parent none clears. --depends none clears. --state is new, triaged, in progress, or closed.
  --type is bug, enhancement, or task. An omitted type is task.
  --priority is low, medium, or high. An omitted create stores medium.
  reporter is --user. A stale rev exits 409 and does not write.
  list prints id, created, state, type, priority, and title. show prints the body.
  create reads the body from stdin when stdin is not a terminal.
  --json: list {tickets:[{id,title,state,type,priority,parent,depends,reporter,created}]};
    show and set {id,path,rev,title,state,type,priority,parent,depends,reporter,created,text};
    create {id,path,rev:0,reporter,created}; purge {purged:[...]};
    conflict adds "error":"conflict".

comment:
  comment list <path> prints each thread id, or the id and resolved.
  comment show <path> <thread> prints the stored body and rev N on stderr.
  comment reply <path> <thread> reads the note text from stdin and prints note N. stderr is rev N.
  comment edit <path> <thread> <note> --rev N reads stdin the same way. Reply with --rev is rejected.
  A negative note exits 400 and does not open a socket. A stale rev exits 409 and does not write.
  The same text exits 0 and does not write.
  --json: list {path,rev,threads}; show {path,rev,id,resolved,notes}; reply and edit {path,id,note,rev}.

delete:
  delete <path> removes that document. The path is sent unchanged. ticket delete <id> removes that ticket and clears it from other tickets' parent and depends. Another socket holding the file exits 409 and writes nothing. stdout is the removed path. --json is {path}.

Exit codes: 0, 1, 2, 400, 404, 409.
  0 success, help, or find equal to replace
  1 five silent seconds or a dead socket
  2 usage
  400, 404, 409 hub status
A stale rev exits 409 and does not write. The shell status is that number modulo 256, so 400 is 144, 404 is 148, and 409 is 153. stderr \`conflict\` or \`error N\` is the hub status.
`;

const VALUE_FLAGS = new Set([
  "port",
  "user",
  "rev",
  "find",
  "replace",
  "title",
  "state",
  "type",
  "priority",
  "parent",
  "depends",
  "repo",
  "name",
  "description",
  "path",
  "message",
  "file",
]);

// Same rejection the hub uses, so a bad name never opens a socket.
export function validUsername(name) {
  return typeof name === "string" && name.length > 0 && !/[\0\r\n<>]/.test(name);
}

// Same rejection the hub uses, so a bad message never opens a socket.
function validCommitMessage(value) {
  if (typeof value !== "string") return null;
  const title = value.trim();
  if (title.length < 1 || title.length > 200 || /[\0\r\n\t]/.test(title)) return null;
  return title;
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

// A terminal has no piped body. Reading it would wait on the keyboard.
function readStdin() {
  if (process.stdin.isTTY === true) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(chunks.join("")));
    process.stdin.on("error", reject);
  });
}

// --file is the whole body. A failure here must not open a socket.
async function createBody(args) {
  if (!args.fileSet) return readStdin();
  if (args.file.length === 0) {
    usage("empty file");
    return null;
  }
  try {
    const info = await stat(args.file);
    if (!info.isFile()) {
      usage(`cannot read ${args.file}`);
      return null;
    }
    return await readFile(args.file, "utf8");
  } catch {
    usage(`cannot read ${args.file}`);
    return null;
  }
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
    prioritySet: false,
    priority: "",
    parentSet: false,
    parent: "",
    dependsSet: false,
    depends: "",
    repoSet: false,
    repo: "",
    nameSet: false,
    name: "",
    descriptionSet: false,
    description: "",
    pathSet: false,
    path: "",
    messageSet: false,
    message: "",
    fileSet: false,
    file: "",
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
      } else if (name === "priority") {
        args.prioritySet = true;
        args.priority = value;
      } else if (name === "parent") {
        args.parentSet = true;
        args.parent = value;
      } else if (name === "depends") {
        args.dependsSet = true;
        args.depends = value;
      } else if (name === "repo") {
        args.repoSet = true;
        args.repo = value;
      } else if (name === "name") {
        args.nameSet = true;
        args.name = value;
      } else if (name === "description") {
        args.descriptionSet = true;
        args.description = value;
      } else if (name === "path") {
        args.pathSet = true;
        args.path = value;
      } else if (name === "message") {
        args.messageSet = true;
        args.message = value;
      } else if (name === "file") {
        args.fileSet = true;
        args.file = value;
      }
      continue;
    }
    // A negative note index is a positional. Short flags are not otherwise accepted.
    if (arg.startsWith("-") && arg !== "-" && !/^-\d+$/.test(arg)) return null;
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

// Lock the same inclusive endpoints the hub turns into held spans.
function touchedLines(doc, from, to) {
  const start = lockIndexAt(doc, from);
  const end = lockIndexAt(doc, to);
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

function printDeleted(msg, json) {
  if (typeof msg.path !== "string") return 1;
  if (json) {
    writeJson({ path: msg.path });
    return 0;
  }
  process.stdout.write(`${msg.path}\n`);
  return 0;
}

async function runDelete(hub, username, docPath, json) {
  hub.send({ type: "delete", username, path: docPath });
  const msg = await hub.next((item) => item.type === "deleted" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  return printDeleted(msg, json);
}

async function runCreate(hub, username, path, json, text) {
  hub.send({ type: "create", username, path, text });
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
  // The find is half-open. Only the last included byte decides the span.
  if (cursor > anchor && lockIndexAt(held.text, anchor) !== lockIndexAt(held.text, cursor - 1)) {
    printConflict(held, json);
    return 409;
  }
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
    if (args.prioritySet) {
      if (!TICKET_PRIORITIES.includes(args.priority)) return { error: "invalid priority" };
      command.priority = args.priority;
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
    if (args.prioritySet) {
      if (!TICKET_PRIORITIES.includes(args.priority)) return { error: "invalid priority" };
      fields.priority = args.priority;
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
    if (Object.keys(fields).length === 0) return { error: "set requires --title, --state, --type, --priority, --parent, or --depends" };
    return { sub, id: more[0], rev, fields };
  }
  if (sub === "delete") {
    if (more.length === 0) return { error: "id required" };
    if (more.length !== 1) return { error: "unexpected argument" };
    if (!validTicketId(more[0])) return { error: "invalid id" };
    return { sub, id: more[0] };
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
  if (!TICKET_PRIORITIES.includes(raw.priority)) return null;
  if (typeof raw.parent !== "string" || (raw.parent !== "" && !validTicketId(raw.parent))) return null;
  if (!Array.isArray(raw.depends) || raw.depends.some((id) => !validTicketId(id))) return null;
  if (typeof raw.reporter !== "string" || typeof raw.created !== "string") return null;
  return {
    id: raw.id,
    title: raw.title,
    state: raw.state,
    type: raw.type,
    priority: raw.priority,
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
  if (!TICKET_PRIORITIES.includes(msg.priority)) return null;
  if (typeof msg.parent !== "string" || (msg.parent !== "" && !validTicketId(msg.parent))) return null;
  if (!Array.isArray(msg.depends) || msg.depends.some((dep) => !validTicketId(dep))) return null;
  if (typeof msg.reporter !== "string" || typeof msg.created !== "string") return null;
  if (typeof msg.rev !== "number") return null;
  return {
    id,
    title: msg.title,
    state: msg.state,
    type: msg.ticketType,
    priority: msg.priority,
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
    metaLine("priority", view.priority),
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
      priority: view.priority,
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
  if (Object.prototype.hasOwnProperty.call(fields, "priority") && fields.priority !== opened.priority) return false;
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
        priority: ticket.priority,
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
    `${ticket.id}\t${ticket.created}\t${ticket.state}\t${ticket.type}\t${ticket.priority}\t${ticket.title}\n`
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
  const payload = { type: "ticket.create", username, title: command.title, body: command.body };
  if (command.state !== undefined) payload.state = command.state;
  if (command.type !== undefined) payload.ticketType = command.type;
  if (command.priority !== undefined) payload.priority = command.priority;
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
  if (Object.prototype.hasOwnProperty.call(fields, "priority")) payload.priority = fields.priority;
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

async function runTicketDelete(hub, username, id, json) {
  hub.send({ type: "ticket.delete", username, id });
  const msg = await hub.next((item) => item.type === "deleted" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  // Parent and depends are cleared after deleted. tickets is that rewrite finishing.
  const listed = await hub.next((item) => item.type === "tickets" || item.type === "error");
  if (listed.type === "error") return serverError(listed);
  if (!Array.isArray(listed.tickets)) return 1;
  return printDeleted(msg, json);
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
  if (command.sub === "delete") return runTicketDelete(hub, username, command.id, args.json);
  if (command.sub === "purge") return runTicketPurge(hub, username, args.json);
  return 2;
}

async function runRepoList(hub, username, json) {
  hub.send({ type: "repos", username });
  const msg = await hub.next((item) => item.type === "repos" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  if (!Array.isArray(msg.repos)) return 1;
  const repos = [];
  for (const repo of msg.repos) {
    if (!repo || typeof repo.name !== "string" || typeof repo.description !== "string" || typeof repo.path !== "string") {
      return 1;
    }
    repos.push({ name: repo.name, description: repo.description, path: repo.path });
  }
  if (json) {
    writeJson({ repos });
    return 0;
  }
  if (repos.length > 0) {
    process.stdout.write(repos.map((repo) => `${repo.name}\t${repo.description}\t${repo.path}\n`).join(""));
  }
  return 0;
}

async function runRepoRegister(hub, username, args) {
  hub.send({
    type: "repo.register",
    username,
    name: args.name,
    description: args.description,
    path: args.path,
  });
  const msg = await hub.next((item) => item.type === "repos" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  const repo = Array.isArray(msg.repos) ? msg.repos.find((item) => item && item.name === args.name) : null;
  if (!repo || typeof repo.description !== "string" || typeof repo.path !== "string") return 1;
  if (args.json) {
    writeJson({ name: repo.name, description: repo.description, path: repo.path });
    return 0;
  }
  process.stdout.write(`${repo.name}\n`);
  return 0;
}

async function runRepoDeregister(hub, username, name, json) {
  hub.send({ type: "repo.deregister", username, name });
  const msg = await hub.next((item) => item.type === "repos" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  if (json) writeJson({ name });
  return 0;
}

function asCommitList(msg) {
  if (!msg || !Array.isArray(msg.commits)) return null;
  for (const item of msg.commits) {
    if (!item || typeof item.author !== "string" || typeof item.subject !== "string") return null;
    if (!Array.isArray(item.paths) || item.paths.some((rel) => typeof rel !== "string")) return null;
  }
  return msg.commits;
}

async function runCommit(hub, username, message, json) {
  const frame = { type: "commit", username };
  if (typeof message === "string") frame.message = message;
  hub.send(frame);
  const msg = await hub.next((item) => item.type === "commit" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  const commits = asCommitList(msg);
  if (!commits) return 1;
  if (json) {
    writeJson(msg);
    return 0;
  }
  if (commits.length > 0) process.stdout.write(commits.map((item) => `${item.subject}\n`).join(""));
  return 0;
}

function commentNoteFields(notes) {
  return notes.map((note) => ({
    id: note.id,
    author: note.author,
    time: note.time,
    text: note.text,
  }));
}

function asCommentNote(raw) {
  if (!raw || typeof raw.id !== "number" || !Number.isInteger(raw.id)) return null;
  if (typeof raw.author !== "string" || typeof raw.time !== "string" || typeof raw.text !== "string") return null;
  return { id: raw.id, author: raw.author, time: raw.time, text: raw.text };
}

function asCommentThread(raw) {
  if (!raw || typeof raw.id !== "string" || typeof raw.resolved !== "boolean" || typeof raw.body !== "string") return null;
  if (!Array.isArray(raw.notes)) return null;
  const notes = [];
  for (const item of raw.notes) {
    const note = asCommentNote(item);
    if (!note) return null;
    notes.push(note);
  }
  return { id: raw.id, resolved: raw.resolved, body: raw.body, notes };
}

function asComments(msg) {
  if (!msg || typeof msg.path !== "string" || typeof msg.rev !== "number" || !Array.isArray(msg.threads)) return null;
  const threads = [];
  for (const raw of msg.threads) {
    const thread = asCommentThread(raw);
    if (!thread) return null;
    threads.push(thread);
  }
  return { path: msg.path, rev: msg.rev, threads };
}

function asCommentResult(msg) {
  if (!msg || typeof msg.path !== "string" || typeof msg.id !== "string") return null;
  if (typeof msg.note !== "number" || !Number.isInteger(msg.note) || typeof msg.rev !== "number") return null;
  return { path: msg.path, id: msg.id, note: msg.note, rev: msg.rev };
}

function printCommentList(msg, json) {
  if (json) {
    writeJson({
      path: msg.path,
      rev: msg.rev,
      threads: msg.threads.map((thread) => ({
        id: thread.id,
        resolved: thread.resolved,
        notes: commentNoteFields(thread.notes),
      })),
    });
    return 0;
  }
  if (msg.threads.length > 0) {
    process.stdout.write(msg.threads.map((thread) => (
      thread.resolved ? `${thread.id} resolved\n` : `${thread.id}\n`
    )).join(""));
  }
  return 0;
}

function printCommentShow(msg, thread, json) {
  if (json) {
    writeJson({
      path: msg.path,
      rev: msg.rev,
      id: thread.id,
      resolved: thread.resolved,
      notes: commentNoteFields(thread.notes),
    });
    return 0;
  }
  process.stdout.write(`${thread.body}\n`);
  process.stderr.write(`rev ${msg.rev}\n`);
  return 0;
}

function printCommentWrite(msg, json) {
  if (json) {
    writeJson({ path: msg.path, id: msg.id, note: msg.note, rev: msg.rev });
    return 0;
  }
  process.stdout.write(`note ${msg.note}\n`);
  process.stderr.write(`rev ${msg.rev}\n`);
  return 0;
}

async function runCommentList(hub, username, docPath, json) {
  hub.send({ type: "comment.threads", username, path: docPath });
  const msg = await hub.next((item) => item.type === "comments" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  const parsed = asComments(msg);
  if (!parsed) return 1;
  return printCommentList(parsed, json);
}

async function runCommentShow(hub, username, docPath, id, json) {
  hub.send({ type: "comment.threads", username, path: docPath });
  const msg = await hub.next((item) => item.type === "comments" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  const parsed = asComments(msg);
  if (!parsed) return 1;
  const thread = parsed.threads.find((item) => item.id === id);
  if (!thread) return serverError({ status: 404 });
  return printCommentShow(parsed, thread, json);
}

async function runCommentReply(hub, username, docPath, id, text, json) {
  hub.send({ type: "comment.reply", username, path: docPath, id, text });
  const msg = await hub.next((item) => item.type === "comment" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  const parsed = asCommentResult(msg);
  if (!parsed || parsed.path !== docPath || parsed.id !== id) return 1;
  return printCommentWrite(parsed, json);
}

async function runCommentEdit(hub, username, docPath, id, note, rev, text, json) {
  hub.send({ type: "comment.edit", username, path: docPath, id, note, rev, text });
  const msg = await hub.next((item) => item.type === "comment" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  const parsed = asCommentResult(msg);
  if (!parsed || parsed.path !== docPath || parsed.id !== id) return 1;
  return printCommentWrite(parsed, json);
}

async function runComment(hub, username, command, text, json) {
  if (command.sub === "list") return runCommentList(hub, username, command.path, json);
  if (command.sub === "show") return runCommentShow(hub, username, command.path, command.id, json);
  if (command.sub === "reply") return runCommentReply(hub, username, command.path, command.id, text, json);
  if (command.sub === "edit") {
    return runCommentEdit(hub, username, command.path, command.id, command.note, command.rev, text, json);
  }
  return 2;
}

function commentFlagRejected(args, sub) {
  if (args.closed || args.findSet || args.replaceSet || args.titleSet || args.stateSet
    || args.typeSet || args.prioritySet || args.parentSet || args.dependsSet
    || args.nameSet || args.descriptionSet || args.pathSet) {
    return true;
  }
  return sub !== "edit" && args.revSet;
}

function parseNoteArg(raw) {
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

function prepareComment(args, rest) {
  const [sub, ...more] = rest;
  if (commentFlagRejected(args, sub)) return { error: "unexpected flag" };
  if (sub === "list") {
    if (more.length === 0) return { error: "path required" };
    if (more.length !== 1) return { error: "unexpected argument" };
    return { sub, path: more[0] };
  }
  if (sub === "show" || sub === "reply") {
    if (more.length === 0) return { error: "path required" };
    if (more.length !== 2) return { error: "unexpected argument" };
    return { sub, path: more[0], id: more[1] };
  }
  if (sub === "edit") {
    if (more.length === 0) return { error: "path required" };
    if (more.length > 3) return { error: "unexpected argument" };
    if (more.length < 3) return { error: "invalid note" };
    const note = parseNoteArg(more[2]);
    if (note === null) return { error: "invalid note" };
    if (note < 0) return { error: "negative note" };
    if (!args.revSet) return { error: "edit requires integer --rev" };
    const rev = parseRev(args.rev);
    if (rev === null) return { error: "edit requires integer --rev" };
    return { sub, path: more[0], id: more[1], note, rev };
  }
  return { error: "unexpected argument" };
}

function serveFlagRejected(args) {
  if (args.json || args.closed) return true;
  return args.revSet || args.findSet || args.replaceSet || args.titleSet
    || args.stateSet || args.typeSet || args.prioritySet || args.parentSet || args.dependsSet
    || args.repoSet || args.nameSet || args.descriptionSet || args.pathSet
    || args.messageSet || args.fileSet;
}

function defaultStateDir() {
  // Omitted DIR is beside this program, not the caller's cwd.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "state");
}

function errorText(err) {
  const text = err instanceof Error && err.stack ? err.stack : String(err);
  return text.endsWith("\n") ? text : `${text}\n`;
}

async function runServe(args, rest) {
  if (serveFlagRejected(args)) {
    usage("unexpected flag");
    return;
  }
  if (rest.length > 1) {
    usage("unexpected argument");
    return;
  }
  const port = parsePort(args.portSet ? args.port : (process.env.VIEWMARK_PORT ?? "8765"));
  if (port === null) {
    usage("invalid port");
    return;
  }
  const dir = rest.length === 1 ? rest[0] : defaultStateDir();
  let server;
  try {
    server = await start(port, dir);
  } catch (err) {
    writeSync(2, errorText(err));
    process.exit(1);
  }
  const bound = server.address().port;
  process.stdout.write(`127.0.0.1:${bound}\t${server.stateDir}\n`);
}

async function withHub(port, username, fn, repo) {
  const hub = connectHub(port, username);
  try {
    await hub.ready;
    if (repo !== undefined) hub.send({ type: "repo", username, name: repo });
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

  if (cmd === "serve") {
    await runServe(args, rest);
    return;
  }

  if (args.messageSet && cmd !== "commit") {
    usage("unexpected flag");
    return;
  }
  if (args.fileSet && cmd !== "create") {
    usage("unexpected flag");
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

  if (cmd === "repo") {
    if (args.repoSet) {
      usage("--repo is not used with repo");
      return;
    }
    const [sub, ...more] = rest;
    if (sub === "list") {
      if (more.length !== 0) {
        usage("unexpected argument");
        return;
      }
      await withHub(port, user, (hub) => runRepoList(hub, user, args.json));
      return;
    }
    if (sub === "register") {
      if (more.length !== 0) {
        usage("unexpected argument");
        return;
      }
      if (!args.nameSet || !args.descriptionSet || !args.pathSet) {
        usage("register requires --name, --description, and --path");
        return;
      }
      await withHub(port, user, (hub) => runRepoRegister(hub, user, args));
      return;
    }
    if (sub === "deregister") {
      if (more.length === 0) {
        usage("name required");
        return;
      }
      if (more.length !== 1) {
        usage("unexpected argument");
        return;
      }
      await withHub(port, user, (hub) => runRepoDeregister(hub, user, more[0], args.json));
      return;
    }
    usage("unknown command");
    return;
  }

  if (cmd !== "list" && cmd !== "show" && cmd !== "create" && cmd !== "edit" && cmd !== "delete" && cmd !== "comment" && cmd !== "ticket" && cmd !== "commit") {
    usage("unknown command");
    return;
  }
  if (!args.repoSet) {
    usage("--repo is required");
    return;
  }

  if (cmd === "list") {
    if (rest.length !== 0) {
      usage("unexpected argument");
      return;
    }
    await withHub(port, user, (hub) => runList(hub, user, args.json), args.repo);
    return;
  }
  if (cmd === "ticket") {
    const command = prepareTicket(args, rest);
    if (command.error) {
      usage(command.error);
      return;
    }
    if (command.sub === "create") command.body = await readStdin();
    await withHub(port, user, (hub) => runTicket(hub, user, args, command), args.repo);
    return;
  }
  if (cmd === "commit") {
    if (rest.length !== 0) {
      usage("unexpected argument");
      return;
    }
    let message;
    if (args.messageSet) {
      message = validCommitMessage(args.message);
      if (message === null) {
        usage("invalid message");
        return;
      }
    }
    await withHub(port, user, (hub) => runCommit(hub, user, message, args.json), args.repo);
    return;
  }
  if (cmd === "comment") {
    const command = prepareComment(args, rest);
    if (command.error === "negative note") {
      process.stderr.write("error 400\n");
      process.exitCode = 400;
      return;
    }
    if (command.error) {
      usage(command.error);
      return;
    }
    let text = "";
    if (command.sub === "reply" || command.sub === "edit") text = await readStdin();
    await withHub(port, user, (hub) => runComment(hub, user, command, text, args.json), args.repo);
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
    await withHub(port, user, (hub) => runShow(hub, user, rest[0], args.json), args.repo);
    return;
  }
  if (cmd === "create") {
    const docPath = normalizeCreate(rest[0]);
    if (!docPath) {
      usage("empty path");
      return;
    }
    const body = await createBody(args);
    if (body === null) return;
    await withHub(port, user, (hub) => runCreate(hub, user, docPath, args.json, body), args.repo);
    return;
  }
  if (cmd === "delete") {
    await withHub(port, user, (hub) => runDelete(hub, user, rest[0], args.json), args.repo);
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
  await withHub(port, user, (hub) => runEdit(hub, user, rest[0], rev, args.find, args.replace, args.json), args.repo);
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
