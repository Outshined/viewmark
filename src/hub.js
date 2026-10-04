import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  addComment,
  backspace,
  createState,
  deleteForward,
  insert,
  lineIndexAt,
  removeCommentThread,
  replaceCommentBody,
  setCommentResolved,
} from "./doc.js";
import {
  TICKET_ALPHABET,
  TICKET_STATES,
  TICKET_TYPES,
  TICKET_PRIORITIES,
  composeTicket,
  generateId,
  parseTicket,
  rejectLink,
} from "./ticket.js";
import { acceptKey, createParser, encodeFrame, encodeText } from "./ws.js";

const PING_MS = 15000;
const CHECKPOINT_MS = 3600000;
const STACK_CAP = 200;

function gitEnv(docsDir, username) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  env.GIT_DIR = path.join(docsDir, ".git");
  env.GIT_WORK_TREE = docsDir;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_EDITOR = "true";
  if (username) {
    const email = `${username}@viewmark.local`;
    env.GIT_AUTHOR_NAME = username;
    env.GIT_AUTHOR_EMAIL = email;
    env.GIT_COMMITTER_NAME = username;
    env.GIT_COMMITTER_EMAIL = email;
  }
  return env;
}

function git(docsDir, args, username) {
  return new Promise((resolve, reject) => {
    const env = gitEnv(docsDir, username);
    execFile("git", args, { cwd: docsDir, env }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

export async function ensureDocsRepo(docsDir, sourceRoot) {
  await fs.mkdir(docsDir, { recursive: true });
  const real = await fs.realpath(docsDir);
  if (real === sourceRoot) {
    throw new Error("docs directory must not be the Viewmark source repo");
  }
  let hasGit = false;
  try {
    const info = await fs.lstat(path.join(real, ".git"));
    hasGit = info.isDirectory() || info.isFile();
  } catch {
    hasGit = false;
  }
  if (!hasGit) {
    const env = gitEnv(real);
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    await new Promise((resolve, reject) => {
      execFile("git", ["init", "--quiet"], { cwd: real, env }, (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve(stdout);
      });
    });
  }
  return real;
}

function validUsername(name) {
  return typeof name === "string" && name.length > 0 && !/[\0\r\n<>]/.test(name);
}

function safeRel(input) {
  if (typeof input !== "string" || input.length === 0 || input.length > 1024) return null;
  if (input.includes("\0") || input.includes("\\")) return null;
  const parts = input.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part === ".git")) return null;
  return parts.join("/");
}

function inside(rootDir, candidate) {
  const rel = path.relative(rootDir, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

async function resolveInside(rootDir, rel) {
  let real;
  try {
    real = await fs.realpath(path.resolve(rootDir, rel));
  } catch {
    return null;
  }
  if (!inside(rootDir, real)) return null;
  return real;
}

async function placedFull(rootDir, dir, name) {
  const parent = dir === "" ? rootDir : await resolveInside(rootDir, dir);
  if (!parent) return null;
  const dest = path.join(parent, name);
  if (!inside(rootDir, dest)) return null;
  return dest;
}

function baseName(rel) {
  const slash = rel.lastIndexOf("/");
  return slash === -1 ? rel : rel.slice(slash + 1);
}

function isTicketTree(rel) {
  return rel === "tickets" || rel.startsWith("tickets/");
}

function containsPath(rootDir, candidate) {
  const rel = path.relative(rootDir, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function validRepoName(name) {
  return typeof name === "string" && REPO_NAME.test(name);
}

function pathConflict(existing, candidate) {
  if (existing === candidate) return "same";
  if (containsPath(existing, candidate) || containsPath(candidate, existing)) return "nest";
  return null;
}

async function loadRepos(stateDir) {
  let text;
  try {
    text = await fs.readFile(path.join(stateDir, "repos.json"), "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return new Map();
    throw err;
  }
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.repos)) throw new Error("invalid repos.json");
  const map = new Map();
  for (const entry of parsed.repos) {
    if (!entry || typeof entry.name !== "string" || typeof entry.description !== "string" || typeof entry.path !== "string") {
      throw new Error("invalid repos.json");
    }
    // Stored paths are already real. Do not mkdir them: a missing tree stays missing.
    map.set(entry.name, {
      name: entry.name,
      description: entry.description,
      path: entry.path,
      files: new Map(),
      dirty: new Map(),
      timer: null,
    });
  }
  return map;
}

async function existsPath(full) {
  try {
    await fs.lstat(full);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

function clampOffset(value, length) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const index = Math.trunc(value);
  if (index < 0) return 0;
  if (index > length) return length;
  return index;
}

function coveringSplice(before, after) {
  if (before === after) return null;
  let prefix = 0;
  const shared = Math.min(before.length, after.length);
  while (prefix < shared && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  return {
    from: prefix,
    to: before.length - suffix,
    inserted: after.slice(prefix, after.length - suffix),
  };
}

function touchedLines(doc, from, to) {
  const start = lineIndexAt(doc, from);
  const end = lineIndexAt(doc, to);
  const lines = [];
  for (let index = Math.min(start, end); index <= Math.max(start, end); index += 1) lines.push(index);
  return lines;
}

function shiftOffset(index, from, to, insertedLen) {
  if (index <= from) return index;
  if (index >= to) return index - (to - from) + insertedLen;
  return from + insertedLen;
}

function shiftCaret(entry, from, to, insertedLen) {
  entry.cursor = shiftOffset(entry.cursor, from, to, insertedLen);
  entry.anchor = shiftOffset(entry.anchor, from, to, insertedLen);
  entry.cursorAfter = shiftOffset(entry.cursorAfter, from, to, insertedLen);
  entry.anchorAfter = shiftOffset(entry.anchorAfter, from, to, insertedLen);
}

// Entries stay in current-document coordinates. A splice that overlaps the
// bytes an entry expects is left in place so the later byte check fails.
function rebaseStack(stack, from, to, inserted, kind, skip) {
  const insertedLen = inserted.length;
  const delta = insertedLen - (to - from);
  for (const entry of stack) {
    if (entry === skip || entry.poison) continue;
    const span = kind === "undo" ? entry.inserted.length : entry.removed.length;
    const regionEnd = entry.at + span;
    if (to <= entry.at) {
      entry.at += delta;
      shiftCaret(entry, from, to, insertedLen);
      continue;
    }
    if (from >= regionEnd) {
      shiftCaret(entry, from, to, insertedLen);
      continue;
    }
    entry.poison = true;
  }
}

function pushCap(stack, entry) {
  stack.push(entry);
  if (stack.length > STACK_CAP) stack.shift();
}

function runOp(text, cursor, anchor, msg) {
  if (msg.op === "insert" || msg.op === "backspace" || msg.op === "delete") {
    const state = createState(text, cursor, anchor);
    let next = state;
    if (msg.op === "insert") next = insert(state, typeof msg.text === "string" ? msg.text : "");
    else if (msg.op === "backspace") next = backspace(state);
    else next = deleteForward(state);
    return { doc: next.doc, cursor: next.cursor, anchor: next.anchor };
  }
  if (msg.op === "comment.add") {
    const result = addComment(text, anchor, cursor);
    if (!result) return null;
    return { doc: result.doc, cursor: result.cursor, anchor: result.cursor };
  }
  const state = createState(text, cursor, anchor);
  let next = state;
  if (msg.op === "comment.save") {
    if (typeof msg.id !== "string") return undefined;
    next = replaceCommentBody(state, msg.id, typeof msg.body === "string" ? msg.body : "");
  } else if (msg.op === "comment.delete") {
    if (typeof msg.id !== "string") return undefined;
    next = removeCommentThread(state, msg.id);
  } else if (msg.op === "comment.resolve") {
    if (typeof msg.id !== "string" || typeof msg.resolved !== "boolean") return undefined;
    next = setCommentResolved(state, msg.id, msg.resolved);
  } else {
    return undefined;
  }
  return { doc: next.doc, cursor: next.cursor, anchor: next.cursor };
}

async function listMarkdown(dir, prefix) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.isSymbolicLink()) continue;
    // tickets/ is the ticket store, not a document tree.
    if (prefix === "" && entry.name === "tickets" && entry.isDirectory()) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await listMarkdown(path.join(dir, entry.name), rel));
    else if (entry.isFile() && (rel.endsWith(".md") || rel.endsWith(".markdown"))) out.push(rel);
  }
  out.sort();
  return out;
}

function headingTitle(text) {
  if (typeof text !== "string") return "";
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const match = /^#\s+(\S.*)$/.exec(line);
    if (!match) continue;
    const title = match[1].trim();
    if (title) return title;
  }
  return "";
}

async function titlesFor(repo, listed) {
  const titles = {};
  for (const rel of listed) {
    const cached = repo.files.get(rel);
    let text = null;
    if (cached && typeof cached.text === "string") text = cached.text;
    else {
      try {
        text = await fs.readFile(path.join(repo.path, rel), "utf8");
      } catch {
        continue;
      }
    }
    const title = headingTitle(text);
    if (title) titles[rel] = title;
  }
  return titles;
}

function ticketIdFromRel(rel) {
  const prefix = "tickets/";
  if (!rel.startsWith(prefix)) return null;
  const name = rel.slice(prefix.length);
  if (name.length !== 11 || !name.endsWith(".md")) return null;
  const id = name.slice(0, 8);
  for (let i = 0; i < id.length; i += 1) {
    if (!TICKET_ALPHABET.includes(id[i])) return null;
  }
  return id;
}

function validTitle(value) {
  if (typeof value !== "string") return null;
  const title = value.trim();
  if (title.length < 1 || title.length > 200 || /[\r\n\t]/.test(title)) return null;
  return title;
}

function ticketView(ticket) {
  return {
    id: ticket.id,
    title: ticket.title,
    state: ticket.state,
    type: ticket.type,
    priority: ticket.priority,
    parent: ticket.parent,
    depends: [...ticket.depends],
    reporter: ticket.reporter,
    created: ticket.created,
  };
}

function ticketNotice(file) {
  const ticket = file.ticket;
  return {
    type: "ticket",
    path: file.rel,
    rev: file.rev,
    title: ticket.title,
    state: ticket.state,
    // Frame `type` is the command, so the ticket type travels as ticketType.
    ticketType: ticket.type,
    priority: ticket.priority,
    parent: ticket.parent,
    depends: [...ticket.depends],
    reporter: ticket.reporter,
    created: ticket.created,
  };
}

function closeCode(reason) {
  if (reason === "binary") return 1003;
  if (reason === "size") return 1009;
  if (reason === "empty") return 1008;
  return 1002;
}

export async function createHub(stateDir, sourceRoot) {
  const repos = await loadRepos(stateDir);
  const sockets = new Set();
  let queue = Promise.resolve();
  let stopped = false;

  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.then(() => {}, () => {});
    return run;
  }

  function safeWrite(socket, data) {
    if (!socket || socket.destroyed || socket.writableEnded) return;
    try {
      socket.write(data);
    } catch {
      // The peer is already gone.
    }
  }

  function send(socket, value) {
    safeWrite(socket, encodeText(value));
  }

  function fail(socket, status) {
    send(socket, { type: "error", status });
  }

  function endSocket(socket, reason) {
    if (!socket || socket.destroyed || socket.session?.ending) return;
    if (socket.session) socket.session.ending = true;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(closeCode(reason));
    safeWrite(socket, encodeFrame(0x8, payload));
    socket.end();
  }

  function arm(repo) {
    if (repo.timer) clearTimeout(repo.timer);
    repo.timer = setTimeout(() => {
      repo.timer = null;
      enqueue(() => checkpoint(repo, null, null, true)).catch((err) => console.error(err));
    }, CHECKPOINT_MS);
    // The listening socket keeps the process up. A quiet repo must not.
    repo.timer.unref();
  }

  function mark(repo, rel, username) {
    repo.dirty.set(rel, username);
    arm(repo);
  }

  async function tracked(repo, rel) {
    try {
      await git(repo.path, ["ls-files", "--error-unmatch", "--", rel]);
      return true;
    } catch (err) {
      const detail = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
      if (/did not match any file/i.test(detail)) return false;
      throw err;
    }
  }

  // git add refuses a missing path that was never committed, so drop it.
  // A path already in the index stays and the next commit records the removal.
  async function markDelete(repo, rel, username) {
    if (await tracked(repo, rel)) {
      mark(repo, rel, username);
      return;
    }
    repo.dirty.delete(rel);
    if (repo.dirty.size === 0 && repo.timer) {
      clearTimeout(repo.timer);
      repo.timer = null;
    }
  }

  async function assertToplevel(repo) {
    const top = (await git(repo.path, ["rev-parse", "--show-toplevel"])).trim();
    const topReal = await fs.realpath(top);
    if (topReal !== repo.path) throw new Error("refusing to commit outside the docs repo");
  }

  async function commitAuthor(repo, username, paths, message) {
    const docsDir = repo.path;
    const email = `${username}@viewmark.local`;
    const config = [
      "-c", `user.name=${username}`,
      "-c", `user.email=${email}`,
      "-c", "commit.gpgsign=false",
      "-c", "core.autocrlf=false",
    ];
    await git(docsDir, [...config, "add", "-A", "--", ...paths], username);
    const subject = message ?? (paths.length === 1 ? `Edit ${paths[0]}` : `Update ${repo.name}`);
    const args = [...config, "commit", "--author", `${username} <${email}>`, "-m", subject];
    if (paths.length > 1) args.push("-m", paths.join("\n"));
    args.push("--", ...paths);
    try {
      await git(docsDir, args, username);
    } catch (err) {
      const detail = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
      if (/nothing to commit|nothing added/i.test(detail)) return null;
      throw err;
    }
    return subject;
  }

  // user null commits every author, sorted, one commit each. background logs
  // and keeps that author's paths; an explicit failure throws and keeps them.
  async function checkpoint(repo, user, message, background) {
    if (!repo) return [];
    const grouped = new Map();
    for (const [rel, author] of repo.dirty) {
      if (user != null && author !== user) continue;
      let paths = grouped.get(author);
      if (!paths) {
        paths = [];
        grouped.set(author, paths);
      }
      paths.push(rel);
    }
    const authors = [...grouped.keys()].sort();
    if (authors.length === 0) {
      if (repo.dirty.size === 0 && repo.timer) {
        clearTimeout(repo.timer);
        repo.timer = null;
      }
      return [];
    }
    try {
      await assertToplevel(repo);
    } catch (err) {
      if (!background) throw err;
      console.error(err);
      if (!repo.timer) arm(repo);
      return [];
    }
    const results = [];
    for (const author of authors) {
      const paths = grouped.get(author).sort();
      try {
        const subject = await commitAuthor(repo, author, paths, message);
        for (const rel of paths) {
          if (repo.dirty.get(rel) === author) repo.dirty.delete(rel);
        }
        if (subject != null) results.push({ author, subject, paths });
      } catch (err) {
        if (!background) throw err;
        console.error(err);
      }
    }
    if (repo.dirty.size === 0 && repo.timer) {
      clearTimeout(repo.timer);
      repo.timer = null;
    } else if (background && repo.dirty.size > 0 && !repo.timer) {
      arm(repo);
    }
    return results;
  }

  function lockSnapshot(file) {
    const lines = [];
    for (const [index, owner] of file.locks) {
      lines.push({ index, username: owner.session.username });
    }
    lines.sort((a, b) => a.index - b.index);
    return lines;
  }

  function syncLocks(file) {
    file.locks = new Map();
    for (const sock of file.subscribers) {
      for (const index of sock.session.lines) file.locks.set(index, sock);
    }
  }

  function broadcast(file, value) {
    const frame = encodeText(value);
    for (const sock of file.subscribers) safeWrite(sock, frame);
  }

  async function writeAtomic(full, text) {
    const dir = path.dirname(full);
    const tmp = path.join(dir, `.${path.basename(full)}.${randomBytes(8).toString("hex")}.tmp`);
    await fs.writeFile(tmp, text);
    try {
      await fs.rename(tmp, full);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  function rebaseFile(file, actor, before, after, splice, skip) {
    const oldSpan = touchedLines(before, splice.from, splice.to);
    const newSpan = touchedLines(after, splice.from, splice.from + splice.inserted.length);
    const oldCount = oldSpan.length;
    const newCount = newSpan.length;
    const delta = newCount - oldCount;
    const oldStart = oldSpan[0];
    const oldEnd = oldSpan[oldSpan.length - 1];
    for (const sock of file.subscribers) {
      const next = new Set();
      let cover = false;
      for (const index of sock.session.lines) {
        if (index < oldStart) next.add(index);
        else if (index > oldEnd) next.add(index + delta);
        else cover = true;
      }
      if (cover) {
        for (let i = 0; i < newCount; i += 1) next.add(oldStart + i);
      }
      sock.session.lines = next;
      if (sock !== actor) {
        sock.session.cursor = shiftOffset(sock.session.cursor, splice.from, splice.to, splice.inserted.length);
        sock.session.anchor = shiftOffset(sock.session.anchor, splice.from, splice.to, splice.inserted.length);
      }
      rebaseStack(sock.session.undo, splice.from, splice.to, splice.inserted, "undo", skip);
      rebaseStack(sock.session.redo, splice.from, splice.to, splice.inserted, "redo", skip);
    }
    syncLocks(file);
  }

  async function publish(socket, file, before, splice, caret, entry, mode) {
    const touched = touchedLines(before, splice.from, splice.to);
    for (const index of touched) {
      const owner = file.locks.get(index);
      if (owner === socket) continue;
      if (owner || mode === "edit") return false;
    }
    const after = before.slice(0, splice.from) + splice.inserted + before.slice(splice.to);
    if (file.ticket) {
      const composed = composeTicket({ ...file.ticket, id: file.ticket.id, body: after });
      if (composed == null) return false;
      await writeAtomic(file.full, composed);
    } else {
      await writeAtomic(file.full, after);
    }
    file.text = after;
    file.rev += 1;
    if (mode !== "edit") {
      for (const index of touched) {
        if (file.locks.get(index) !== socket) socket.session.lines.add(index);
      }
    }
    rebaseFile(file, socket, before, after, splice, entry);
    socket.session.cursor = caret.cursor;
    socket.session.anchor = caret.anchor;
    mark(socket.session.repo, file.rel, socket.session.username);
    // The preparatory lock covers the splice, including a fence through EOF.
    // Keep the caret line so the rest can be taken.
    socket.session.lines = new Set(touchedLines(file.text, caret.cursor, caret.cursor));
    syncLocks(file);
    broadcast(file, {
      type: "doc",
      path: file.rel,
      rev: file.rev,
      text: file.text,
      from: splice.from,
      to: splice.to,
      inserted: splice.inserted,
      actor: socket.session.username,
      cursor: caret.cursor,
      anchor: caret.anchor,
    });
    broadcast(file, {
      type: "locks",
      path: file.rel,
      rev: file.rev,
      lines: lockSnapshot(file),
    });
    return true;
  }

  async function releaseFile(socket) {
    const session = socket.session;
    const files = session?.repo?.files;
    if (!session || !files) return;
    const rel = session.docPath;
    if (!rel) return;
    const file = files.get(rel);
    session.docPath = null;
    session.lines = new Set();
    session.undo = [];
    session.redo = [];
    session.anchor = 0;
    session.cursor = 0;
    if (file) {
      file.subscribers.delete(socket);
      syncLocks(file);
      if (file.subscribers.size > 0) {
        broadcast(file, { type: "locks", path: file.rel, rev: file.rev, lines: lockSnapshot(file) });
      }
    }
  }

  async function loadFile(repo, rel) {
    const files = repo.files;
    const docsDir = repo.path;
    const cached = files.get(rel);
    if (cached) return cached;
    const full = path.resolve(docsDir, rel);
    let real;
    try {
      real = await fs.realpath(full);
    } catch {
      return null;
    }
    if (!inside(docsDir, real)) return null;
    let info;
    try {
      info = await fs.stat(real);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;
    const text = await fs.readFile(real, "utf8");
    const ticketId = ticketIdFromRel(rel);
    if (ticketId) {
      const parsed = parseTicket(ticketId, text);
      if (!parsed) return null;
      const file = {
        rel,
        full: real,
        rev: 0,
        text: parsed.body,
        ticket: ticketView(parsed),
        subscribers: new Set(),
        locks: new Map(),
      };
      files.set(rel, file);
      return file;
    }
    const file = { rel, full: real, rev: 0, text, subscribers: new Set(), locks: new Map() };
    files.set(rel, file);
    return file;
  }

  async function collectTickets(repo) {
    const docsDir = repo.path;
    const files = repo.files;
    const dir = path.join(docsDir, "tickets");
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return [];
      throw err;
    }
    const tickets = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile()) continue;
      const rel = `tickets/${entry.name}`;
      const id = ticketIdFromRel(rel);
      if (!id) continue;
      const cached = files.get(rel);
      if (cached) {
        if (cached.ticket) tickets.push(ticketView(cached.ticket));
        continue;
      }
      let raw;
      try {
        raw = await fs.readFile(path.join(dir, entry.name), "utf8");
      } catch {
        continue;
      }
      const parsed = parseTicket(id, raw);
      if (!parsed) continue;
      tickets.push(ticketView(parsed));
    }
    tickets.sort((a, b) => {
      if (a.created < b.created) return -1;
      if (a.created > b.created) return 1;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    return tickets;
  }

  async function broadcastTickets(repo) {
    const msg = { type: "tickets", tickets: await collectTickets(repo) };
    for (const sock of sockets) {
      if (sock.session?.repo === repo) send(sock, msg);
    }
  }

  async function prepareTicketDest(repo, id) {
    const docsDir = repo.path;
    const parent = path.resolve(docsDir, "tickets");
    try {
      await fs.mkdir(parent, { recursive: true });
    } catch {
      return null;
    }
    let parentReal;
    try {
      parentReal = await fs.realpath(parent);
    } catch {
      return null;
    }
    if (!inside(docsDir, parentReal)) return null;
    const dest = path.join(parentReal, `${id}.md`);
    if (!inside(docsDir, dest)) return null;
    return dest;
  }

  async function docsPayload(repo) {
    const listed = await listMarkdown(repo.path, "");
    return { type: "docs", files: listed, titles: await titlesFor(repo, listed) };
  }

  function broadcastDocs(repo, msg) {
    for (const sock of sockets) {
      if (sock.session?.repo === repo) send(sock, msg);
    }
  }

  function fileFrame(file) {
    const message = {
      type: "file",
      path: file.rel,
      rev: file.rev,
      text: file.text,
      locks: lockSnapshot(file),
    };
    if (file.ticket) message.ticket = ticketView(file.ticket);
    return message;
  }

  function retargetOpen(oldRel, file) {
    const message = fileFrame(file);
    const targets = new Set(file.subscribers);
    for (const sock of sockets) {
      if (sock.session?.docPath === oldRel) targets.add(sock);
    }
    for (const sock of targets) {
      if (!sock.session) continue;
      sock.session.docPath = file.rel;
      send(sock, message);
    }
  }

  async function onList(socket) {
    const repo = socket.session.repo;
    if (!repo) return fail(socket, 400);
    send(socket, await docsPayload(repo));
  }

  async function onMove(socket, msg) {
    const repo = socket.session.repo;
    if (!repo) return fail(socket, 400);
    const files = repo.files;
    const docsDir = repo.path;
    const rel = safeRel(msg.path);
    if (!rel) return fail(socket, 404);
    if (!Object.prototype.hasOwnProperty.call(msg, "dir") || typeof msg.dir !== "string") return fail(socket, 404);
    let dir = "";
    if (msg.dir !== "") {
      dir = safeRel(msg.dir);
      if (!dir) return fail(socket, 404);
    }
    if (isTicketTree(rel) || (dir !== "" && isTicketTree(dir))) return fail(socket, 400);

    const listed = await listMarkdown(docsDir, "");
    const fileMove = listed.includes(rel);
    const nested = listed.filter((item) => item.startsWith(`${rel}/`));
    if (!fileMove && nested.length === 0) return fail(socket, 404);
    if (dir !== "" && !listed.some((item) => item.startsWith(`${dir}/`))) return fail(socket, 404);
    if (!fileMove && (dir === rel || dir.startsWith(`${rel}/`))) return fail(socket, 400);

    const pairs = [];
    if (fileMove) {
      const dest = dir ? `${dir}/${baseName(rel)}` : baseName(rel);
      pairs.push({ src: rel, dest });
    } else {
      const destRoot = dir ? `${dir}/${baseName(rel)}` : baseName(rel);
      for (const item of nested) pairs.push({ src: item, dest: destRoot + item.slice(rel.length) });
    }
    // Leaving every path where it is does not dirty the repo or the listeners.
    if (pairs.every((pair) => pair.src === pair.dest)) return;

    const destCount = new Map();
    for (const pair of pairs) destCount.set(pair.dest, (destCount.get(pair.dest) || 0) + 1);
    if ([...destCount.values()].some((count) => count > 1)) return fail(socket, 409);
    const sources = new Set(pairs.map((pair) => pair.src));
    for (const pair of pairs) {
      if (pair.src === pair.dest) continue;
      if (sources.has(pair.dest) || files.has(pair.dest)) return fail(socket, 409);
      if (await existsPath(path.join(docsDir, pair.dest))) return fail(socket, 409);
    }
    if (!fileMove) {
      const destRoot = dir ? `${dir}/${baseName(rel)}` : baseName(rel);
      if (destRoot !== rel && (files.has(destRoot) || (await existsPath(path.join(docsDir, destRoot))))) {
        return fail(socket, 409);
      }
    }

    const srcReal = await resolveInside(docsDir, rel);
    if (!srcReal) return fail(socket, 404);
    const destFull = await placedFull(docsDir, dir, baseName(rel));
    if (!destFull) return fail(socket, 404);
    if (await existsPath(destFull)) return fail(socket, 409);
    await fs.rename(srcReal, destFull);

    const opened = [];
    for (const pair of pairs) {
      const cached = files.get(pair.src);
      if (!cached) continue;
      files.delete(pair.src);
      cached.rel = pair.dest;
      cached.full = fileMove ? destFull : path.join(destFull, pair.src.slice(rel.length + 1));
      files.set(pair.dest, cached);
      opened.push({ src: pair.src, file: cached });
    }
    const username = socket.session.username;
    for (const pair of pairs) {
      await markDelete(repo, pair.src, username);
      mark(repo, pair.dest, username);
    }
    for (const item of opened) retargetOpen(item.src, item.file);
    broadcastDocs(repo, await docsPayload(repo));
  }

  async function onOpen(socket, msg) {
    const repo = socket.session.repo;
    if (!repo) return fail(socket, 400);
    const rel = safeRel(msg.path);
    if (!rel) return fail(socket, 404);
    if (rel === "tickets" || (rel.startsWith("tickets/") && !ticketIdFromRel(rel))) return fail(socket, 404);
    const file = await loadFile(repo, rel);
    if (!file) return fail(socket, 404);
    const session = socket.session;
    if (session.docPath !== rel) {
      await releaseFile(socket);
      session.docPath = rel;
      session.anchor = 0;
      session.cursor = 0;
      session.lines = new Set();
      session.undo = [];
      session.redo = [];
      file.subscribers.add(socket);
    }
    const message = {
      type: "file",
      path: file.rel,
      rev: file.rev,
      text: file.text,
      locks: lockSnapshot(file),
    };
    if (file.ticket) message.ticket = ticketView(file.ticket);
    send(socket, message);
  }

  async function onCreate(socket, msg) {
    const repo = socket.session.repo;
    if (!repo) return fail(socket, 400);
    const files = repo.files;
    const docsDir = repo.path;
    const rel = safeRel(msg.path);
    if (!rel) return fail(socket, 404);
    if (rel === "tickets" || rel.startsWith("tickets/")) return fail(socket, 400);
    if (!rel.endsWith(".md") && !rel.endsWith(".markdown")) return fail(socket, 400);
    if (files.has(rel)) return fail(socket, 409);
    const full = path.resolve(docsDir, rel);
    if (await existsPath(full)) return fail(socket, 409);
    const parent = path.dirname(full);
    try {
      await fs.mkdir(parent, { recursive: true });
    } catch {
      return fail(socket, 404);
    }
    let parentReal;
    try {
      parentReal = await fs.realpath(parent);
    } catch {
      return fail(socket, 404);
    }
    // A parent symlink can resolve outside the docs repo. Refuse before writing.
    if (!inside(docsDir, parentReal)) return fail(socket, 404);
    const dest = path.join(parentReal, path.basename(rel));
    if (!inside(docsDir, dest)) return fail(socket, 404);
    if (await existsPath(dest)) return fail(socket, 409);
    await writeAtomic(dest, "");
    files.set(rel, { rel, full: dest, rev: 0, text: "", subscribers: new Set(), locks: new Map() });
    mark(repo, rel, socket.session.username);
    broadcastDocs(repo, await docsPayload(repo));
    await onOpen(socket, { path: rel });
  }

  async function onTickets(socket) {
    const repo = socket.session.repo;
    if (!repo) return fail(socket, 400);
    send(socket, { type: "tickets", tickets: await collectTickets(repo) });
  }

  async function onTicketCreate(socket, msg) {
    const repo = socket.session.repo;
    if (!repo) return fail(socket, 400);
    const files = repo.files;
    const title = validTitle(msg.title);
    if (!title) return fail(socket, 400);
    let state = "new";
    if (Object.prototype.hasOwnProperty.call(msg, "state")) {
      if (typeof msg.state !== "string" || !TICKET_STATES.includes(msg.state)) return fail(socket, 400);
      state = msg.state;
    }
    let type = "task";
    if (Object.prototype.hasOwnProperty.call(msg, "ticketType")) {
      if (typeof msg.ticketType !== "string" || !TICKET_TYPES.includes(msg.ticketType)) return fail(socket, 400);
      type = msg.ticketType;
    }
    let body = "";
    if (Object.prototype.hasOwnProperty.call(msg, "body")) {
      if (typeof msg.body !== "string") return fail(socket, 400);
      body = msg.body;
    }
    let priority = "medium";
    if (Object.prototype.hasOwnProperty.call(msg, "priority")) {
      if (typeof msg.priority !== "string" || !TICKET_PRIORITIES.includes(msg.priority)) return fail(socket, 400);
      priority = msg.priority;
    }
    const reporter = socket.session.username;
    const created = new Date().toISOString();
    let allocated = null;
    for (let draw = 0; draw < 8; draw += 1) {
      const id = generateId();
      const rel = `tickets/${id}.md`;
      if (files.has(rel)) continue;
      const dest = await prepareTicketDest(repo, id);
      if (!dest) return fail(socket, 500);
      if (await existsPath(dest)) continue;
      allocated = { id, rel, dest };
      break;
    }
    if (!allocated) return fail(socket, 500);
    const ticket = {
      id: allocated.id,
      title,
      state,
      type,
      priority,
      parent: "",
      depends: [],
      reporter,
      created,
    };
    const composed = composeTicket({ ...ticket, body });
    if (composed == null) return fail(socket, 500);
    await writeAtomic(allocated.dest, composed);
    files.set(allocated.rel, {
      rel: allocated.rel,
      full: allocated.dest,
      rev: 0,
      text: body,
      ticket,
      subscribers: new Set(),
      locks: new Map(),
    });
    mark(repo, allocated.rel, socket.session.username);
    await broadcastTickets(repo);
    await onOpen(socket, { path: allocated.rel });
  }

  async function onTicketSet(socket, msg) {
    const repo = socket.session.repo;
    if (!repo) return fail(socket, 400);
    if (Object.prototype.hasOwnProperty.call(msg, "reporter") || Object.prototype.hasOwnProperty.call(msg, "created")) {
      return fail(socket, 400);
    }
    const rel = safeRel(msg.path);
    if (!rel || !ticketIdFromRel(rel)) return fail(socket, 404);
    const file = await loadFile(repo, rel);
    if (!file || !file.ticket) return fail(socket, 404);
    const next = { ...file.ticket, depends: [...file.ticket.depends] };
    if (Object.prototype.hasOwnProperty.call(msg, "title")) next.title = msg.title;
    if (Object.prototype.hasOwnProperty.call(msg, "state")) next.state = msg.state;
    if (Object.prototype.hasOwnProperty.call(msg, "ticketType")) next.type = msg.ticketType;
    if (Object.prototype.hasOwnProperty.call(msg, "priority")) next.priority = msg.priority;
    if (Object.prototype.hasOwnProperty.call(msg, "parent")) next.parent = msg.parent;
    if (Object.prototype.hasOwnProperty.call(msg, "depends")) next.depends = msg.depends;
    const composed = composeTicket({ ...next, id: file.ticket.id, body: file.text });
    if (composed == null) return fail(socket, 400);
    if (typeof msg.rev !== "number" || msg.rev !== file.rev) return fail(socket, 409);
    const parsed = parseTicket(file.ticket.id, composed);
    if (!parsed) return fail(socket, 400);
    const reason = rejectLink(await collectTickets(repo), parsed.id, parsed.parent, parsed.depends);
    if (reason) return fail(socket, 409);
    const current = composeTicket({ ...file.ticket, body: file.text });
    if (composed === current) return;
    await writeAtomic(file.full, composed);
    file.ticket = ticketView(parsed);
    file.rev += 1;
    mark(repo, file.rel, socket.session.username);
    await broadcastTickets(repo);
    broadcast(file, ticketNotice(file));
  }

  async function rewriteTicketLinks(repo, id, parent, depends, username) {
    const files = repo.files;
    const docsDir = repo.path;
    const rel = `tickets/${id}.md`;
    const cached = files.get(rel);
    if (cached && cached.ticket) {
      const next = { ...cached.ticket, parent, depends };
      const composed = composeTicket({ ...next, body: cached.text });
      const current = composeTicket({ ...cached.ticket, body: cached.text });
      if (composed == null || composed === current) return;
      await writeAtomic(cached.full, composed);
      cached.ticket = ticketView(next);
      cached.rev += 1;
      broadcast(cached, ticketNotice(cached));
      mark(repo, rel, username);
      return;
    }
    const full = path.join(docsDir, rel);
    let raw;
    try {
      raw = await fs.readFile(full, "utf8");
    } catch {
      return;
    }
    const parsed = parseTicket(id, raw);
    if (!parsed) return;
    const composed = composeTicket({ ...parsed, parent, depends });
    if (composed == null || composed === raw) return;
    await writeAtomic(full, composed);
    mark(repo, rel, username);
  }

  async function onTicketPurge(socket) {
    const repo = socket.session.repo;
    if (!repo) return fail(socket, 400);
    const files = repo.files;
    const docsDir = repo.path;
    const all = await collectTickets(repo);
    const closedIds = new Set(all.filter((ticket) => ticket.state === "closed").map((ticket) => ticket.id));
    for (const id of closedIds) {
      const rel = `tickets/${id}.md`;
      const cached = files.get(rel);
      files.delete(rel);
      await fs.rm(cached ? cached.full : path.join(docsDir, rel), { force: true });
      await markDelete(repo, rel, socket.session.username);
    }
    for (const ticket of all) {
      if (closedIds.has(ticket.id)) continue;
      const parent = closedIds.has(ticket.parent) ? "" : ticket.parent;
      const depends = ticket.depends.filter((dep) => !closedIds.has(dep));
      if (parent === ticket.parent && depends.length === ticket.depends.length) continue;
      await rewriteTicketLinks(repo, ticket.id, parent, depends, socket.session.username);
    }
    await broadcastTickets(repo);
  }

  async function onLock(socket, msg) {
    const session = socket.session;
    const files = session.repo?.files;
    if (!files) return fail(socket, 400);
    const file = files.get(session.docPath);
    if (!file || msg.path !== file.rel) return fail(socket, 409);
    if (typeof msg.rev !== "number" || msg.rev !== file.rev) return fail(socket, 409);
    const anchor = clampOffset(msg.anchor, file.text.length);
    const cursor = clampOffset(msg.cursor, file.text.length);
    if (anchor == null || cursor == null) return fail(socket, 400);
    const nextLines = new Set(touchedLines(file.text, Math.min(anchor, cursor), Math.max(anchor, cursor)));
    for (const index of nextLines) {
      const owner = file.locks.get(index);
      if (owner && owner !== socket) return fail(socket, 409);
    }
    session.lines = nextLines;
    session.anchor = anchor;
    session.cursor = cursor;
    syncLocks(file);
    broadcast(file, { type: "locks", path: file.rel, rev: file.rev, lines: lockSnapshot(file) });
  }

  async function onEdit(socket, msg) {
    const session = socket.session;
    const files = session.repo?.files;
    if (!files) return fail(socket, 400);
    const file = files.get(session.docPath);
    if (!file || msg.path !== file.rel) return fail(socket, 409);
    if (typeof msg.rev !== "number" || msg.rev !== file.rev) return fail(socket, 409);
    const savedCursor = session.cursor;
    const savedAnchor = session.anchor;
    if (typeof msg.anchor === "number" || typeof msg.cursor === "number") {
      const anchor = clampOffset(msg.anchor, file.text.length);
      const cursor = clampOffset(msg.cursor, file.text.length);
      if (anchor == null || cursor == null) return fail(socket, 400);
      session.anchor = anchor;
      session.cursor = cursor;
    }
    const produced = runOp(file.text, session.cursor, session.anchor, msg);
    if (produced === undefined || produced === null || coveringSplice(file.text, produced.doc) == null) {
      session.cursor = savedCursor;
      session.anchor = savedAnchor;
      if (produced === undefined) return fail(socket, 400);
      if (produced === null) return fail(socket, 409);
      return;
    }
    const splice = coveringSplice(file.text, produced.doc);
    const entry = {
      at: splice.from,
      removed: file.text.slice(splice.from, splice.to),
      inserted: splice.inserted,
      cursor: session.cursor,
      anchor: session.anchor,
      cursorAfter: produced.cursor,
      anchorAfter: produced.anchor,
      poison: false,
    };
    // comment.add must already hold every spliced line. A later fence edit
    // runs after publish shrinks that hold to the caret, so free lines stay
    // editable and another owner's lines do not.
    const mode = msg.op === "comment.save" || msg.op === "comment.resolve" || msg.op === "comment.delete"
      ? "comment"
      : "edit";
    const wrote = await publish(
      socket,
      file,
      file.text,
      splice,
      { cursor: produced.cursor, anchor: produced.anchor },
      null,
      mode,
    );
    if (!wrote) {
      session.cursor = savedCursor;
      session.anchor = savedAnchor;
      return fail(socket, 409);
    }
    session.redo = [];
    pushCap(session.undo, entry);
  }

  async function onHistory(socket, msg, direction) {
    const session = socket.session;
    const files = session.repo?.files;
    if (!files) return fail(socket, 400);
    const file = files.get(session.docPath);
    if (!file || msg.path !== file.rel) return fail(socket, 409);
    if (typeof msg.rev !== "number" || msg.rev !== file.rev) return fail(socket, 409);
    const stack = direction === "undo" ? session.undo : session.redo;
    const entry = stack[stack.length - 1];
    if (!entry) return fail(socket, 409);
    const present = direction === "undo" ? entry.inserted : entry.removed;
    const replacement = direction === "undo" ? entry.removed : entry.inserted;
    const at = entry.at;
    if (entry.poison || at < 0 || at > file.text.length || file.text.slice(at, at + present.length) !== present) {
      return fail(socket, 409);
    }
    const splice = { from: at, to: at + present.length, inserted: replacement };
    const caret = direction === "undo"
      ? { cursor: entry.cursor, anchor: entry.anchor }
      : { cursor: entry.cursorAfter, anchor: entry.anchorAfter };
    const wrote = await publish(socket, file, file.text, splice, caret, entry, "history");
    if (!wrote) return fail(socket, 409);
    stack.pop();
    if (direction === "undo") pushCap(session.redo, entry);
    else pushCap(session.undo, entry);
  }

  async function disconnect(socket) {
    const session = socket.session;
    if (!session || session.gone) return;
    session.gone = true;
    sockets.delete(socket);
    await releaseFile(socket);
    session.undo = [];
    session.redo = [];
    session.lines = new Set();
  }

  function reposPayload() {
    const list = [...repos.values()].map(({ name, description, path }) => ({ name, description, path }));
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { type: "repos", repos: list };
  }

  function broadcastRepos() {
    const msg = reposPayload();
    for (const sock of sockets) send(sock, msg);
  }

  async function saveRegistry() {
    const body = reposPayload();
    await writeAtomic(path.join(stateDir, "repos.json"), `${JSON.stringify({ repos: body.repos })}\n`);
  }

  function clearDocState(session) {
    session.docPath = null;
    session.lines = new Set();
    session.undo = [];
    session.redo = [];
    session.anchor = 0;
    session.cursor = 0;
  }

  async function dropRepoSelection(repo) {
    for (const sock of [...sockets]) {
      if (sock.session?.repo !== repo) continue;
      await releaseFile(sock);
      sock.session.repo = null;
      clearDocState(sock.session);
    }
  }

  function onRepos(socket) {
    send(socket, reposPayload());
  }

  async function onRegister(socket, msg) {
    if (!validRepoName(msg.name)) return fail(socket, 400);
    const description = validTitle(msg.description);
    if (!description) return fail(socket, 400);
    if (typeof msg.path !== "string" || msg.path.length === 0 || msg.path.includes("\0")) return fail(socket, 400);
    if (repos.has(msg.name)) return fail(socket, 409);

    const resolved = path.resolve(msg.path);
    let real = null;
    try {
      real = await fs.realpath(resolved);
    } catch (err) {
      if (!err || err.code !== "ENOENT") return fail(socket, 400);
    }
    if (real === sourceRoot) return fail(socket, 400);
    const candidates = real ? [real] : [resolved];
    for (const other of repos.values()) {
      for (const candidate of candidates) {
        const hit = pathConflict(other.path, candidate);
        if (hit === "same") return fail(socket, 409);
        if (hit === "nest") return fail(socket, 400);
      }
    }
    if (!real) {
      try {
        await fs.mkdir(resolved, { recursive: true });
        real = await fs.realpath(resolved);
      } catch {
        return fail(socket, 400);
      }
      // A symlink parent can land inside a registered root after mkdir.
      if (real === sourceRoot) return fail(socket, 400);
      for (const other of repos.values()) {
        const hit = pathConflict(other.path, real);
        if (hit === "same") return fail(socket, 409);
        if (hit === "nest") return fail(socket, 400);
      }
    } else {
      let info;
      try {
        info = await fs.stat(real);
      } catch {
        return fail(socket, 400);
      }
      if (!info.isDirectory()) return fail(socket, 400);
    }

    try {
      real = await ensureDocsRepo(real, sourceRoot);
    } catch (err) {
      if (err && err.message === "docs directory must not be the Viewmark source repo") return fail(socket, 400);
      console.error(err);
      return fail(socket, 500);
    }
    for (const other of repos.values()) {
      const hit = pathConflict(other.path, real);
      if (hit === "same") return fail(socket, 409);
      if (hit === "nest") return fail(socket, 400);
    }

    const repo = { name: msg.name, description, path: real, files: new Map(), dirty: new Map(), timer: null };
    repos.set(repo.name, repo);
    try {
      await saveRegistry();
    } catch (err) {
      repos.delete(repo.name);
      throw err;
    }
    broadcastRepos();
  }

  async function onDeregister(socket, msg) {
    if (typeof msg.name !== "string") return fail(socket, 404);
    const repo = repos.get(msg.name);
    if (!repo) return fail(socket, 404);
    await checkpoint(repo, null, null);
    if (repo.timer) {
      clearTimeout(repo.timer);
      repo.timer = null;
    }
    await dropRepoSelection(repo);
    repos.delete(repo.name);
    repo.files.clear();
    try {
      await saveRegistry();
    } catch (err) {
      repos.set(repo.name, repo);
      throw err;
    }
    broadcastRepos();
  }

  async function onSelect(socket, msg) {
    if (typeof msg.name !== "string") return fail(socket, 404);
    const repo = repos.get(msg.name);
    if (!repo) return fail(socket, 404);
    const session = socket.session;
    if (session.repo === repo) return;
    if (session.repo) await checkpoint(session.repo, session.username, null);
    await releaseFile(socket);
    session.repo = repo;
    clearDocState(session);
  }

  async function onCommit(socket, msg) {
    const repo = socket.session.repo;
    if (!repo) return fail(socket, 400);
    let message = null;
    if (Object.prototype.hasOwnProperty.call(msg, "message")) {
      if (typeof msg.message !== "string" || msg.message.includes("\0")) return fail(socket, 400);
      message = validTitle(msg.message);
      if (!message) return fail(socket, 400);
    }
    const commits = await checkpoint(repo, socket.session.username, message);
    send(socket, { type: "commit", commits });
  }

  async function handleText(socket, payload) {
    if (socket.session?.gone || socket.session?.ending) return;
    let msg;
    try {
      msg = JSON.parse(payload.toString("utf8"));
    } catch {
      endSocket(socket, "protocol");
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
      endSocket(socket, "protocol");
      return;
    }
    const session = socket.session;
    if (session.username == null) {
      if (msg.type !== "hello" || !validUsername(msg.username)) {
        endSocket(socket, msg.type === "hello" ? "empty" : "protocol");
        return;
      }
      session.username = msg.username;
      return;
    }
    if (msg.type === "pong") {
      if (msg.username !== undefined && msg.username !== session.username) return fail(socket, 403);
      return;
    }
    if (msg.username !== session.username) return fail(socket, 403);
    if (msg.type === "repos") return onRepos(socket);
    if (msg.type === "repo.register") return onRegister(socket, msg);
    if (msg.type === "repo.deregister") return onDeregister(socket, msg);
    if (msg.type === "repo") return onSelect(socket, msg);
    if (msg.type === "commit") return onCommit(socket, msg);
    if (msg.type === "list") return onList(socket);
    if (msg.type === "move") return onMove(socket, msg);
    if (msg.type === "open") return onOpen(socket, msg);
    if (msg.type === "create") return onCreate(socket, msg);
    if (msg.type === "tickets") return onTickets(socket);
    if (msg.type === "ticket.create") return onTicketCreate(socket, msg);
    if (msg.type === "ticket.set") return onTicketSet(socket, msg);
    if (msg.type === "ticket.purge") return onTicketPurge(socket);
    if (msg.type === "lock") return onLock(socket, msg);
    if (msg.type === "edit") return onEdit(socket, msg);
    if (msg.type === "undo") return onHistory(socket, msg, "undo");
    if (msg.type === "redo") return onHistory(socket, msg, "redo");
    fail(socket, 400);
  }

  function attach(socket) {
    const session = {
      username: null,
      repo: null,
      docPath: null,
      anchor: 0,
      cursor: 0,
      lines: new Set(),
      undo: [],
      redo: [],
      gone: false,
      ending: false,
    };
    socket.session = session;
    sockets.add(socket);
    socket.setNoDelay(true);
    const parser = createParser({
      requireMask: true,
      onText(payload) {
        enqueue(() => handleText(socket, payload)).catch((err) => {
          console.error(err);
          fail(socket, 500);
        });
      },
      onPing(payload) {
        safeWrite(socket, encodeFrame(0xa, payload));
      },
      onClose() {
        endSocket(socket, "protocol");
      },
      onError(reason) {
        endSocket(socket, reason);
      },
    });
    socket.on("data", (chunk) => parser.push(chunk));
    socket.on("close", () => {
      enqueue(() => disconnect(socket)).catch((err) => console.error(err));
    });
    socket.on("error", () => {});
  }

  const pingTimer = setInterval(() => {
    const frame = encodeText({ type: "ping" });
    for (const sock of sockets) safeWrite(sock, frame);
  }, PING_MS);
  // The listening socket keeps the process up. This timer must not.
  pingTimer.unref();

  return {
    stateDir,
    repoPath(name) {
      const repo = repos.get(name);
      return repo ? repo.path : null;
    },
    handleUpgrade(req, socket, head) {
      if (stopped) {
        socket.destroy();
        return;
      }
      let pathname = req.url ?? "";
      const query = pathname.indexOf("?");
      if (query !== -1) pathname = pathname.slice(0, query);
      if (pathname !== "/api/ws") {
        socket.destroy();
        return;
      }
      const upgrade = String(req.headers.upgrade ?? "");
      const connection = String(req.headers.connection ?? "");
      const key = req.headers["sec-websocket-key"];
      if (!key || req.headers["sec-websocket-version"] !== "13" || !/websocket/i.test(upgrade) || !/upgrade/i.test(connection)) {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
        return;
      }
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
          "\r\n",
      );
      attach(socket);
      if (head && head.length > 0) socket.emit("data", head);
    },
    shutdown() {
      // Close can observe the http server before a socket "close" listener
      // runs. Checkpoint first so that work is on this queue, then drop sessions.
      if (!stopped) {
        stopped = true;
        clearInterval(pingTimer);
        for (const repo of repos.values()) {
          if (repo.timer) {
            clearTimeout(repo.timer);
            repo.timer = null;
          }
          enqueue(() => checkpoint(repo, null, null, true)).catch((err) => console.error(err));
        }
        for (const sock of [...sockets]) {
          enqueue(() => disconnect(sock)).catch((err) => console.error(err));
          sock.destroy();
        }
      }
      return queue;
    },
  };
}
