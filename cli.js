#!/usr/bin/env node

import { realpathSync, writeSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "./server.js";
import { parseUnifiedDiff } from "./src/doc.js";
import { TICKET_ALPHABET, TICKET_PRIORITIES, TICKET_STATES, TICKET_TYPES } from "./src/ticket.js";
import { MAX_PAYLOAD } from "./src/ws.js";

const HELP = `viewmark talks to the document hub, one command, then exit.

Usage:
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME list
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME show <path>
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME create <path> [--file PATH]
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME edit <path> [--start LINE:OFFSET --end LINE:OFFSET]
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME attach <path> --start LINE:OFFSET --end LINE:OFFSET --expect TEXT
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME delete <path>
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME move <path> [--dir DIR]
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME rev <path>
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME comment list <path>
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME comment show <path> <thread>
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME comment reply <path> <thread>
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME comment add <path> --start LINE:OFFSET --end LINE:OFFSET --expect TEXT
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME comment edit <path> <thread> <note> --expect TEXT
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME comment resolve <path> <thread>
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME comment open <path> <thread>
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME comment delete <path> <thread>
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME commit [--message TEXT]
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME ticket list [--closed]
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME ticket show <id>
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME ticket create --title TEXT [--state STATE] [--type TYPE] [--priority PRIORITY] [--assignee NAME]
  viewmark [--port PORT] [--user NAME] [--json] --repo NAME ticket set <id> [--title TEXT] [--state STATE] [--type TYPE] [--priority PRIORITY] [--parent ID] [--depends IDS] [--assignee NAME]
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
--repo is required on list, show, create, edit, attach, delete, move, rev, comment, commit, and ticket.
serve keeps running. The default directory is \`state\` beside the program, and --user is not required.

stdout and stderr:
  list: one path per line on stdout
  show: the document text on stdout and rev N on stderr
  create: path on stdout and rev 0 on stderr
  edit: the diff on stdin, then the same stdout and stderr as show
  commit: the subject on stdout, or nothing when commits is empty. stderr is empty.
  conflict: the held text on stdout and rev N plus conflict on stderr, then held by NAME when the hub names that user
  context: the held text on stdout and rev N plus context on stderr
  match count other than one: matches N on stderr
  overlapping matches: overlap on stderr
  other statuses: error STATUS on stderr, then held by NAME or the reason when the hub names one
  Each hunk is its own splice, so unchanged text between hunks stays put. Another socket's span is 409 and names that user, and a comment range that overlaps a fence or a table or splits a comment is 409 and names that.
  --json: one object plus a newline and empty stderr:
    list {files}; show and edit {path,rev,text}; create {path,rev:0};
    conflict {path,rev,text,error:"conflict"} and heldBy only when the hub names that user;
    context {path,rev,text,error:"context"};
    commit {type:"commit",commits:[{author,subject,paths}]}
  repo list: name, description, and path, tab-separated, in name order
  repo register: the name
  repo deregister: nothing
  --json repo list {repos}; register {name,description,path}; deregister {name}

Example of one ranged diff:
  printf '%s\n' '@@' '-Hello' '+Hi' | viewmark --user alice --repo docs edit hello.md

edit:
  The diff is stdin when stdin is not a terminal. A terminal sends an empty diff.
  --start and --end together limit the slice. Neither means the whole document.
  Lines count from 1. Offset counts from 0 and may equal the line length. The end is exclusive.
  A reversed pair is ordered. Out of range is 400 and writes nothing.
  @@ numbers do not place a hunk. A hunk with no old lines is rejected.
  No hunks leaves the file as it was and does not open a socket.
  Zero matches exits 409 and does not write. Several matches or an overlap exits 2 and does not write.
  A change outside the slice does not reject the diff. --rev, --find, and --replace are rejected.

attach:
  The image is stdin. Empty stdin, or more than 2 MiB, exits 400 and does not open a socket.
  --start LINE:OFFSET --end LINE:OFFSET --expect TEXT are required. A missing flag does not open a socket.
  Lines count from 1. Offset counts from 0. The end is exclusive. A reversed pair is ordered.
  --expect is the bytes at that range. A mismatch exits 409 and writes nothing.
  A range outside the document exits 400 and writes nothing. A range that spans two blocks exits 400 and writes nothing.
  The picture follows the block that holds the range, as its own paragraph. An empty range on the empty line between two paragraphs puts the line on that empty line. The paragraph that holds the range stays one paragraph.
  --rev, --find, and --replace are rejected.
  stdout and stderr match show. A refusal writes nothing on stdout.

create:
  The body is stdin when stdin is not a terminal. A terminal sends an empty body. --file PATH reads that file instead and does not read stdin.

commit:
  --message TEXT is optional. An omitted message lets the hub choose the subject.
  The message is trimmed and must be 1–200 characters. CR, LF, tab, and NUL are rejected.

ticket:
  list [--closed], show <id>, create --title TEXT [--state STATE] [--type TYPE] [--priority PRIORITY] [--assignee NAME], set <id>, delete <id>, purge.
  --title, --state, --type, --priority, --parent, --depends, --assignee, --closed.
  --parent none clears. --depends none clears. --state is new, triaged, in progress, blocked, pending review, or closed.
  --type is bug, enhancement, or task. An omitted type is task.
  --priority is low, medium, or high. An omitted create stores medium.
  reporter is --user. A field write uses the current body. Later field writes win. --rev is rejected.
  list prints id, created, state, type, priority, and title. show prints the body.
  create reads the body from stdin when stdin is not a terminal.
  --json: list {tickets:[{id,title,state,type,priority,assignee,parent,depends,reporter,created}]};
    show and set {id,path,rev,title,state,type,priority,assignee,parent,depends,reporter,created,text};
    create {id,path,rev:0,reporter,created}; purge {purged:[...]};
    conflict adds "error":"conflict".

comment:
  comment list <path> prints each thread id, or the id and resolved.
  comment show <path> <thread> prints the stored body and rev N on stderr.
  comment reply <path> <thread> reads the note text from stdin and prints note N. stderr is rev N.
  A reply goes through \`comment reply\`, not through \`edit\`. An agent leaves a question with \`comment add PATH --start LINE:OFFSET --end LINE:OFFSET --expect TEXT\` and the question on stdin. \`--expect\` is the bytes at that range. Lines count from 1. Offset counts from 0. The end offset is exclusive.
  comment add <path> --start LINE:OFFSET --end LINE:OFFSET --expect TEXT reads the question from stdin and prints the thread id. stderr is rev N.
  comment edit <path> <thread> <note> --expect TEXT reads the replacement from stdin. --expect is the note text after the poster line. --rev is rejected.
  A negative note exits 400 and does not open a socket. A mismatched --expect exits 409 and does not write.
  The same text exits 0 and does not write.
  comment resolve <path> <thread> marks that thread resolved and prints the id and resolved. stderr is rev N. Already resolved exits 0 and writes nothing.
  comment open <path> <thread> clears resolved and prints the id and open. stderr is rev N. Already open exits 0 and writes nothing.
  comment delete <path> <thread> removes that thread's marks and its fence and prints the id. stderr is rev N.
  The author is note 0's author, the --user of the command. Anyone else exits 403 and writes nothing. A missing path or thread exits 404. A span held by another socket exits 409 and names that user. --rev on comment resolve, comment open, and comment delete is rejected.
  --json: list {path,rev,threads}; show {path,rev,id,resolved,notes}; reply and edit {path,id,note,rev}; add {path,id,note:0,rev}; resolve {path,id,resolved:true,rev}; open {path,id,resolved:false,rev}; delete {path,id,rev}.

delete:
  delete <path> removes that document. The path is sent unchanged. ticket delete <id> removes that ticket and clears it from other tickets' parent and depends. Another socket holding the file exits 409 and writes nothing. stdout is the removed path. --json is {path}.

Exit codes: 0, 1, 2, 400, 404, 409.
  0 success, help, or an empty diff
  1 five silent seconds or a dead socket
  2 usage, several matches, or an overlap
  400, 404, 409 hub status
A context mismatch exits 409 and does not write. The shell status is that number modulo 256, so 400 is 144, 404 is 148, and 409 is 153. stderr \`conflict\`, \`context\`, or \`error N\` is the hub status.
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
  "assignee",
  "repo",
  "name",
  "description",
  "path",
  "message",
  "file",
  "dir",
  "start",
  "end",
  "expect",
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

// The picture is raw bytes. A text encoding would change them before the hub sees the frame.
function readStdinBytes() {
  if (process.stdin.isTTY === true) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
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
    assigneeSet: false,
    assignee: "",
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
    dirSet: false,
    dir: "",
    startSet: false,
    start: "",
    endSet: false,
    end: "",
    expectSet: false,
    expect: "",
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
      } else if (name === "assignee") {
        args.assigneeSet = true;
        args.assignee = value;
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
      } else if (name === "dir") {
        args.dirSet = true;
        args.dir = value;
      } else if (name === "start") {
        args.startSet = true;
        args.start = value;
      } else if (name === "end") {
        args.endSet = true;
        args.end = value;
      } else if (name === "expect") {
        args.expectSet = true;
        args.expect = value;
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

function printContext(doc, json) {
  if (json) {
    writeJson({ path: doc.path, rev: doc.rev, text: doc.text, error: "context" });
    return;
  }
  process.stdout.write(doc.text);
  process.stderr.write(`rev ${doc.rev}\ncontext\n`);
}

function printConflict(doc, json, heldBy) {
  const name = typeof heldBy === "string" && heldBy ? heldBy : "";
  if (json) {
    const body = { path: doc.path, rev: doc.rev, text: doc.text, error: "conflict" };
    if (name) body.heldBy = name;
    writeJson(body);
    return;
  }
  process.stdout.write(doc.text);
  process.stderr.write(`rev ${doc.rev}\nconflict\n`);
  if (name) process.stderr.write(`held by ${name}\n`);
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

  function sendBinary(bytes) {
    const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    ws.send(payload);
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

  return { ready, send, sendBinary, next, finish };
}

function serverError(msg) {
  const status = statusOf(msg);
  if (status === null) return 1;
  process.stderr.write(`error ${status}\n`);
  if (typeof msg.heldBy === "string" && msg.heldBy) process.stderr.write(`held by ${msg.heldBy}\n`);
  else if (typeof msg.reason === "string" && msg.reason) process.stderr.write(`${msg.reason}\n`);
  return status;
}

function asDoc(msg) {
  if (!msg || typeof msg.path !== "string" || typeof msg.rev !== "number" || typeof msg.text !== "string") return null;
  return { path: msg.path, rev: msg.rev, text: msg.text };
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

async function runRev(hub, username, docPath, json) {
  hub.send({ type: "rev", username, path: docPath });
  const msg = await hub.next((item) => item.type === "rev" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  if (typeof msg.path !== "string" || typeof msg.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(msg.sha256)) return 1;
  if (json) {
    writeJson({ path: msg.path, sha256: msg.sha256 });
    return 0;
  }
  process.stdout.write(`${msg.sha256}\n`);
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

function printMoved(msg, json) {
  if (!msg || !Array.isArray(msg.moves)) return 1;
  if (msg.moves.some((move) => typeof move.path !== "string" || typeof move.dest !== "string")) return 1;
  if (json) {
    if (msg.moves.length === 1 && msg.moves[0].path === msg.path) {
      writeJson({ path: msg.moves[0].path, dest: msg.moves[0].dest });
      return 0;
    }
    writeJson({ moves: msg.moves.map((move) => ({ path: move.path, dest: move.dest })) });
    return 0;
  }
  if (msg.moves.length > 0) process.stdout.write(msg.moves.map((move) => `${move.dest}\n`).join(""));
  return 0;
}

async function runMove(hub, username, docPath, dir, json) {
  hub.send({ type: "move", username, path: docPath, dir });
  const msg = await hub.next((item) => item.type === "moved" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  return printMoved(msg, json);
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

async function runAttach(hub, username, docPath, bytes, start, end, expect, json) {
  hub.send({ type: "attach", username, path: docPath, start, end, expect });
  hub.sendBinary(bytes);
  const msg = await hub.next((item) => item.type === "file" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  const doc = asDoc(msg);
  if (!doc) return 1;
  printShow(doc, json);
  return 0;
}

async function runEdit(hub, username, path, diff, range, json) {
  const payload = { type: "diff", username, path, diff };
  if (range) {
    payload.start = range.start;
    payload.end = range.end;
  }
  hub.send(payload);
  const msg = await hub.next((item) => item.type === "file" || item.type === "error");
  if (msg.type === "error") {
    if (msg.status === 409 && typeof msg.text === "string") {
      const doc = asDoc(msg);
      if (!doc) return 1;
      if (msg.reason === "context") {
        printContext(doc, json);
        return 409;
      }
      printConflict(doc, json, msg.heldBy);
      return 409;
    }
    if (msg.status === 2 && msg.reason === "matches") {
      process.stderr.write(`matches ${msg.matches}\n`);
      return 2;
    }
    if (msg.status === 2 && msg.reason === "overlap") {
      process.stderr.write("overlap\n");
      return 2;
    }
    return serverError(msg);
  }
  const doc = asDoc(msg);
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

function assigneeForSet(raw) {
  if (typeof raw !== "string" || /[\r\n\t]/.test(raw)) return raw;
  return raw.trim();
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
  if (args.revSet || args.findSet || args.replaceSet || args.expectSet) return { error: "unexpected flag" };
  const [sub, ...more] = rest;
  if (args.assigneeSet && sub !== "create" && sub !== "set") return { error: "unexpected flag" };
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
    if (args.assigneeSet) command.assignee = assigneeForSet(args.assignee);
    return command;
  }
  if (sub === "set") {
    if (more.length === 0) return { error: "id required" };
    if (more.length !== 1) return { error: "unexpected argument" };
    if (!validTicketId(more[0])) return { error: "invalid id" };
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
    if (args.assigneeSet) fields.assignee = assigneeForSet(args.assignee);
    if (Object.keys(fields).length === 0) return { error: "set requires --title, --state, --type, --priority, --parent, --depends, or --assignee" };
    return { sub, id: more[0], fields };
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
  const assignee = raw.assignee == null ? "" : raw.assignee;
  if (typeof assignee !== "string") return null;
  if (typeof raw.parent !== "string" || (raw.parent !== "" && !validTicketId(raw.parent))) return null;
  if (!Array.isArray(raw.depends) || raw.depends.some((id) => !validTicketId(id))) return null;
  if (typeof raw.reporter !== "string" || typeof raw.created !== "string") return null;
  return {
    id: raw.id,
    title: raw.title,
    state: raw.state,
    type: raw.type,
    priority: raw.priority,
    assignee,
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
  const assignee = msg.assignee == null ? "" : msg.assignee;
  if (typeof assignee !== "string") return null;
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
    assignee,
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
  ];
  if (view.assignee) lines.push(`assignee ${view.assignee}`);
  lines.push(
    metaLine("parent", view.parent),
    metaLine("depends", view.depends.join(",")),
    metaLine("reporter", view.reporter),
    metaLine("created", view.created),
  );
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
      assignee: view.assignee || "",
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
  if (Object.prototype.hasOwnProperty.call(fields, "assignee") && fields.assignee !== (opened.assignee || "")) return false;
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
        assignee: ticket.assignee || "",
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
  if (command.assignee !== undefined) payload.assignee = command.assignee;
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
  // The hub stays silent when the composed ticket would not change.
  if (requestedMatches(opened, command.fields)) return printTicket(opened, json, false), 0;
  const payload = {
    type: "ticket.set",
    username,
    path: opened.path,
  };
  const fields = command.fields;
  if (Object.prototype.hasOwnProperty.call(fields, "title")) payload.title = fields.title;
  if (Object.prototype.hasOwnProperty.call(fields, "state")) payload.state = fields.state;
  if (Object.prototype.hasOwnProperty.call(fields, "parent")) payload.parent = fields.parent;
  if (Object.prototype.hasOwnProperty.call(fields, "depends")) payload.depends = fields.depends;
  if (Object.prototype.hasOwnProperty.call(fields, "type")) payload.ticketType = fields.type;
  if (Object.prototype.hasOwnProperty.call(fields, "priority")) payload.priority = fields.priority;
  if (Object.prototype.hasOwnProperty.call(fields, "assignee")) payload.assignee = fields.assignee;
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

function printCommentAdd(msg, json) {
  if (json) {
    writeJson({ path: msg.path, id: msg.id, note: 0, rev: msg.rev });
    return 0;
  }
  process.stdout.write(`${msg.id}\n`);
  process.stderr.write(`rev ${msg.rev}\n`);
  return 0;
}

function asCommentState(msg) {
  if (!msg || typeof msg.path !== "string" || typeof msg.id !== "string") return null;
  if (typeof msg.resolved !== "boolean" || typeof msg.rev !== "number") return null;
  return {
    path: msg.path,
    id: msg.id,
    resolved: msg.resolved,
    rev: msg.rev,
    unchanged: msg.unchanged === true,
  };
}

function asCommentGone(msg) {
  if (!msg || typeof msg.path !== "string" || typeof msg.id !== "string" || typeof msg.rev !== "number") return null;
  if (typeof msg.note !== "undefined" || typeof msg.resolved !== "undefined") return null;
  return { path: msg.path, id: msg.id, rev: msg.rev };
}

function printCommentResolve(msg, resolved, json) {
  if (msg.unchanged) return 0;
  if (json) {
    writeJson({ path: msg.path, id: msg.id, resolved, rev: msg.rev });
    return 0;
  }
  process.stdout.write(`${msg.id} ${resolved ? "resolved" : "open"}\n`);
  process.stderr.write(`rev ${msg.rev}\n`);
  return 0;
}

function printCommentDelete(msg, json) {
  if (json) {
    writeJson({ path: msg.path, id: msg.id, rev: msg.rev });
    return 0;
  }
  process.stdout.write(`${msg.id}\n`);
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

async function runCommentEdit(hub, username, docPath, id, note, text, expect, json) {
  hub.send({ type: "comment.edit", username, path: docPath, id, note, text, expect });
  const msg = await hub.next((item) => item.type === "comment" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  const parsed = asCommentResult(msg);
  if (!parsed || parsed.path !== docPath || parsed.id !== id) return 1;
  return printCommentWrite(parsed, json);
}

async function runCommentResolve(hub, username, docPath, id, resolved, json) {
  hub.send({ type: "comment.resolve", username, path: docPath, id, resolved });
  const msg = await hub.next((item) => item.type === "comment" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  const parsed = asCommentState(msg);
  if (!parsed || parsed.path !== docPath || parsed.id !== id || parsed.resolved !== resolved) return 1;
  return printCommentResolve(parsed, resolved, json);
}

async function runCommentDelete(hub, username, docPath, id, json) {
  hub.send({ type: "comment.delete", username, path: docPath, id });
  const msg = await hub.next((item) => item.type === "comment" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  const parsed = asCommentGone(msg);
  if (!parsed || parsed.path !== docPath || parsed.id !== id) return 1;
  return printCommentDelete(parsed, json);
}

async function runCommentAdd(hub, username, docPath, start, end, expect, text, json) {
  hub.send({
    type: "comment.add",
    username,
    path: docPath,
    start,
    end,
    expect,
    text,
  });
  const msg = await hub.next((item) => item.type === "comment" || item.type === "error");
  if (msg.type === "error") return serverError(msg);
  const parsed = asCommentResult(msg);
  if (!parsed || parsed.path !== docPath || parsed.note !== 0) return 1;
  return printCommentAdd(parsed, json);
}

async function runComment(hub, username, command, text, json) {
  if (command.sub === "list") return runCommentList(hub, username, command.path, json);
  if (command.sub === "show") return runCommentShow(hub, username, command.path, command.id, json);
  if (command.sub === "reply") return runCommentReply(hub, username, command.path, command.id, text, json);
  if (command.sub === "add") {
    return runCommentAdd(hub, username, command.path, command.start, command.end, command.expect, text, json);
  }
  if (command.sub === "edit") {
    return runCommentEdit(hub, username, command.path, command.id, command.note, text, command.expect, json);
  }
  if (command.sub === "resolve") return runCommentResolve(hub, username, command.path, command.id, true, json);
  if (command.sub === "open") return runCommentResolve(hub, username, command.path, command.id, false, json);
  if (command.sub === "delete") return runCommentDelete(hub, username, command.path, command.id, json);
  return 2;
}

function commentFlagRejected(args, sub) {
  if (args.closed || args.findSet || args.replaceSet || args.titleSet || args.stateSet
    || args.typeSet || args.prioritySet || args.parentSet || args.dependsSet || args.assigneeSet
    || args.nameSet || args.descriptionSet || args.pathSet || args.revSet) {
    return true;
  }
  if (args.expectSet && sub !== "edit" && sub !== "add") return true;
  if ((args.startSet || args.endSet) && sub !== "add") return true;
  return false;
}

function parseNoteArg(raw) {
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

function parseLineOffset(raw) {
  if (typeof raw !== "string") return null;
  const match = /^(-?\d+):(-?\d+)$/.exec(raw);
  if (!match) return null;
  const line = Number(match[1]);
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(offset)) return null;
  return { line, offset };
}

// Same boundary the hub refuses inside a note. Rejecting it here sends nothing.
const NOTE_SEPARATOR = /^::(?: (0|[1-9]\d*))?$/;

function noteHasSeparator(text) {
  for (const line of text.split("\n")) {
    if (NOTE_SEPARATOR.test(line)) return true;
  }
  return false;
}

function prepareComment(args, rest) {
  const [sub, ...more] = rest;
  if (commentFlagRejected(args, sub)) return { error: "unexpected flag" };
  if (sub === "list") {
    if (more.length === 0) return { error: "path required" };
    if (more.length !== 1) return { error: "unexpected argument" };
    return { sub, path: more[0] };
  }
  if (sub === "show" || sub === "reply" || sub === "resolve" || sub === "open" || sub === "delete") {
    if (more.length === 0) return { error: "path required" };
    if (more.length !== 2) return { error: "unexpected argument" };
    return { sub, path: more[0], id: more[1] };
  }
  if (sub === "add") {
    if (more.length === 0) return { error: "path required" };
    if (more.length !== 1) return { error: "unexpected argument" };
    if (!args.startSet || !args.endSet) return { error: "add requires --start and --end" };
    const start = parseLineOffset(args.start);
    const end = parseLineOffset(args.end);
    if (!start || !end) return { error: "invalid position" };
    if (!args.expectSet) return { error: "add requires --expect" };
    return { sub, path: more[0], start, end, expect: args.expect };
  }
  if (sub === "edit") {
    if (more.length === 0) return { error: "path required" };
    if (more.length > 3) return { error: "unexpected argument" };
    if (more.length < 3) return { error: "invalid note" };
    const note = parseNoteArg(more[2]);
    if (note === null) return { error: "invalid note" };
    if (note < 0) return { error: "negative note" };
    if (!args.expectSet) return { error: "edit requires --expect" };
    return { sub, path: more[0], id: more[1], note, expect: args.expect };
  }
  return { error: "unexpected argument" };
}

function serveFlagRejected(args) {
  if (args.json || args.closed) return true;
  return args.revSet || args.findSet || args.replaceSet || args.titleSet
    || args.stateSet || args.typeSet || args.prioritySet || args.parentSet || args.dependsSet || args.assigneeSet
    || args.repoSet || args.nameSet || args.descriptionSet || args.pathSet
    || args.messageSet || args.fileSet || args.dirSet || args.startSet || args.endSet || args.expectSet;
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

  if (args.assigneeSet && cmd !== "ticket") {
    usage("unexpected flag");
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
  if (args.dirSet && cmd !== "move") {
    usage("unexpected flag");
    return;
  }
  if (args.expectSet && cmd !== "comment" && cmd !== "attach") {
    usage("unexpected flag");
    return;
  }
  if (args.endSet && cmd !== "comment" && cmd !== "edit" && cmd !== "attach") {
    usage("unexpected flag");
    return;
  }
  if (args.startSet && cmd !== "comment" && cmd !== "edit" && cmd !== "attach") {
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

  if (cmd !== "list" && cmd !== "show" && cmd !== "create" && cmd !== "edit" && cmd !== "attach" && cmd !== "delete" && cmd !== "move" && cmd !== "rev" && cmd !== "comment" && cmd !== "ticket" && cmd !== "commit") {
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
    if (command.sub === "reply" || command.sub === "edit" || command.sub === "add") text = await readStdin();
    if (command.sub === "add") {
      const samePoint = command.start.line === command.end.line && command.start.offset === command.end.offset;
      if (text === "" || noteHasSeparator(text) || samePoint
        || command.start.line < 1 || command.end.line < 1
        || command.start.offset < 0 || command.end.offset < 0) {
        process.stderr.write("error 400\n");
        process.exitCode = 400;
        return;
      }
    }
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

  if (cmd === "rev") {
    await withHub(port, user, (hub) => runRev(hub, user, rest[0], args.json), args.repo);
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
  if (cmd === "move") {
    await withHub(port, user, (hub) => runMove(hub, user, rest[0], args.dir, args.json), args.repo);
    return;
  }
  if (cmd === "attach") {
    if (args.revSet || args.findSet || args.replaceSet) {
      usage("unexpected flag");
      return;
    }
    if (!args.startSet || !args.endSet) {
      usage("attach requires --start and --end");
      return;
    }
    if (!args.expectSet) {
      usage("attach requires --expect");
      return;
    }
    const start = parseLineOffset(args.start);
    const end = parseLineOffset(args.end);
    if (!start || !end) {
      usage("invalid position");
      return;
    }
    const bytes = await readStdinBytes();
    if (bytes.length === 0) {
      process.stderr.write("error 400\nempty image\n");
      process.exitCode = 400;
      return;
    }
    if (bytes.length > MAX_PAYLOAD) {
      process.stderr.write("error 400\nimage is too large\n");
      process.exitCode = 400;
      return;
    }
    await withHub(port, user, (hub) => runAttach(hub, user, rest[0], bytes, start, end, args.expect, args.json), args.repo);
    return;
  }

  if (args.revSet || args.findSet || args.replaceSet) {
    usage("unexpected flag");
    return;
  }
  if (args.startSet !== args.endSet) {
    usage("edit requires --start and --end");
    return;
  }
  let range = null;
  if (args.startSet) {
    const start = parseLineOffset(args.start);
    const end = parseLineOffset(args.end);
    if (!start || !end) {
      usage("invalid position");
      return;
    }
    range = { start, end };
  }
  const diff = await readStdin();
  const parsed = parseUnifiedDiff(diff);
  if (parsed.error === "invalid") {
    usage("invalid diff");
    return;
  }
  if (parsed.error === "no-context") {
    usage("hunk has no context");
    return;
  }
  if (parsed.hunks.length === 0) return;
  await withHub(port, user, (hub) => runEdit(hub, user, rest[0], diff, range, args.json), args.repo);
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
