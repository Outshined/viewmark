#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HELP = `viewmark talks to the document hub, one command, then exit.

Usage:
  viewmark [--port PORT] [--user NAME] [--json] list
  viewmark [--port PORT] [--user NAME] [--json] show <path>
  viewmark [--port PORT] [--user NAME] [--json] create <path>
  viewmark [--port PORT] [--user NAME] [--json] edit <path> --rev N --find TEXT --replace TEXT
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

Exit codes: 0, 1, 2, 400, 404, 409.
  0 success, help, or find equal to replace
  1 five silent seconds or a dead socket
  2 usage
  400, 404, 409 hub status
A stale rev exits 409 and does not write. The shell status is that number modulo 256, so 400 is 144, 404 is 148, and 409 is 153. stderr \`conflict\` or \`error N\` is the hub status.
`;

const VALUE_FLAGS = new Set(["port", "user", "rev", "find", "replace"]);

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
