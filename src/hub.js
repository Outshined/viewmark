import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  addComment,
  appendCommentReply,
  commentRangeReason,
  backspace,
  commentThreads,
  createState,
  deleteForward,
  insert,
  moveText,
  lockIndexAt,
  lockSpans,
  offsetAt,
  parseCommentNotes,
  parseUnifiedDiff,
  planDiff,
  removeCommentThread,
  replaceCommentBody,
  reviseCommentNote,
  setCommentResolved,
  splitCommentNote,
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

async function copyStock(source, dest) {
  try {
    await fs.lstat(dest);
    return;
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
  try {
    await fs.copyFile(source, dest);
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
}

// git init adds .git, so emptiness is the work tree from before that command.
async function seedEmptyWorkTree(real, sourceRoot) {
  await copyStock(path.join(sourceRoot, "samples", "welcome.md"), path.join(real, "welcome.md"));
  const dest = path.join(real, "tickets", "seedmark.md");
  try {
    await fs.lstat(dest);
    return;
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
  const source = path.join(sourceRoot, "samples", "tickets", "seedmark.md");
  try {
    await fs.lstat(source);
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  await fs.mkdir(path.join(real, "tickets"));
  try {
    await fs.copyFile(source, dest);
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
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
    const entries = await fs.readdir(real);
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
    if (entries.length === 0) await seedEmptyWorkTree(real, sourceRoot);
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

function isMarkdownPath(rel) {
  return rel.endsWith(".md") || rel.endsWith(".markdown");
}

// A comment may sit on a ticket document. The tickets directory, a deeper
// path, and a non-markdown path are not documents.
function commentPathAllowed(rel) {
  if (!isMarkdownPath(rel)) return false;
  if (rel === "tickets" || rel.startsWith("tickets/")) return ticketIdFromRel(rel) !== null;
  return true;
}

const COMMENT_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

function commentView(thread) {
  return {
    id: thread.id,
    resolved: thread.resolved === true,
    // Show prints this fence text. The split notes are the json view of it.
    body: thread.body,
    notes: parseCommentNotes(thread.body).map((note) => {
      const parts = splitCommentNote(note.raw);
      return { id: note.id, author: parts.author, time: parts.time, text: parts.text };
    }),
  };
}

// Resolve, open, and delete belong to the thread's first note.
function noteZeroAuthor(body) {
  const notes = parseCommentNotes(body).filter((note) => note.id === 0);
  if (notes.length !== 1) return { error: notes.length === 0 ? 403 : 400 };
  const author = splitCommentNote(notes[0].raw).author;
  if (!author) return { error: 403 };
  return { author };
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

function applyOne(text, change) {
  return text.slice(0, change.from) + change.inserted + text.slice(change.to);
}

function overlapsSpan(span, change) {
  const { from, to } = change;
  if (from === to) return from > span.start && from <= span.end;
  return from <= span.end && to > span.start;
}

function shiftClosed(span, change) {
  const delta = change.inserted.length - (change.to - change.from);
  if (change.to <= span.start) return { start: span.start + delta, end: span.end + delta };
  if (change.from > span.end) return span;
  return null;
}

// A span is touched when the change overlaps it, or when a change that misses
// it leaves the shifted bounds no longer exactly one lock span. lockIndexAt's
// fallthrough to the last span is not this rule.
function touchedIndices(doc, change) {
  const spans = lockSpans(doc);
  const after = applyOne(doc, change);
  const next = lockSpans(after);
  const hit = [];
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i];
    if (overlapsSpan(span, change)) {
      hit.push(i);
      continue;
    }
    const shifted = shiftClosed(span, change);
    if (!shifted || !next.some((item) => item.start === shifted.start && item.end === shifted.end)) hit.push(i);
  }
  return { spans, after, next, hit };
}

function rebaseLineSet(lines, touched, change) {
  const { spans, next, hit } = touched;
  const hitSet = new Set(hit);
  const mapped = new Map();
  for (let i = 0; i < spans.length; i += 1) {
    if (hitSet.has(i)) continue;
    const shifted = shiftClosed(spans[i], change);
    mapped.set(i, next.findIndex((item) => item.start === shifted.start && item.end === shifted.end));
  }
  const runs = [];
  let run = null;
  for (const index of hit) {
    if (!run || index !== run[run.length - 1] + 1) {
      run = [index];
      runs.push(run);
    } else {
      run.push(index);
    }
  }
  const held = new Set(lines);
  const out = new Set();
  for (const index of held) {
    if (hitSet.has(index)) continue;
    const at = mapped.get(index);
    if (at != null && at >= 0) out.add(at);
  }
  for (const indexes of runs) {
    let owns = false;
    for (const index of indexes) if (held.has(index)) owns = true;
    if (!owns) continue;
    const left = indexes[0] - 1;
    const right = indexes[indexes.length - 1] + 1;
    const start = left < 0 ? 0 : mapped.get(left) + 1;
    const end = right >= spans.length ? next.length : mapped.get(right);
    for (let i = start; i < end; i += 1) out.add(i);
  }
  return out;
}

function touchedLines(doc, from, to) {
  const start = lockIndexAt(doc, from);
  const end = lockIndexAt(doc, to);
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

// An insertion that ends at a change's from is before that change, not an overlap.
function rebaseUndoChanges(entry, ext) {
  let eFrom = ext.from;
  let eTo = ext.to;
  const eLen = ext.inserted.length;
  for (let i = entry.changes.length - 1; i >= 0; i -= 1) {
    const change = entry.changes[i];
    const regionEnd = change.from + change.inserted.length;
    if (eTo <= change.from) {
      const delta = eLen - (eTo - eFrom);
      change.from += delta;
      change.to += delta;
      continue;
    }
    if (eFrom >= regionEnd) {
      const delta = change.removed.length - change.inserted.length;
      eFrom += delta;
      eTo += delta;
      continue;
    }
    return false;
  }
  return true;
}

function rebaseRedoChanges(entry, ext) {
  let eFrom = ext.from;
  let eTo = ext.to;
  const eLen = ext.inserted.length;
  for (const change of entry.changes) {
    if (eTo <= change.from) {
      const delta = eLen - (eTo - eFrom);
      change.from += delta;
      change.to += delta;
      continue;
    }
    if (eFrom >= change.to) {
      const delta = change.inserted.length - (change.to - change.from);
      eFrom += delta;
      eTo += delta;
      continue;
    }
    return false;
  }
  return true;
}

// Entries stay in current-document coordinates. A splice that overlaps the
// bytes an entry expects is left in place so the later byte check fails.
function rebaseStack(stack, change, kind, skip) {
  for (const entry of stack) {
    if (entry === skip || entry.poison) continue;
    const ok = kind === "undo" ? rebaseUndoChanges(entry, change) : rebaseRedoChanges(entry, change);
    if (!ok) {
      entry.poison = true;
      continue;
    }
    shiftCaret(entry, change.from, change.to, change.inserted.length);
  }
}

function copyChanges(changes) {
  return changes.map((change) => ({
    from: change.from,
    to: change.to,
    inserted: change.inserted,
    removed: change.removed,
  }));
}

function inverseChanges(changes) {
  const out = [];
  for (let i = changes.length - 1; i >= 0; i -= 1) {
    const change = changes[i];
    out.push({
      from: change.from,
      to: change.from + change.inserted.length,
      inserted: change.removed,
      removed: change.inserted,
    });
  }
  return out;
}

function changesApply(text, changes, direction) {
  let doc = text;
  if (direction === "undo") {
    for (let i = changes.length - 1; i >= 0; i -= 1) {
      const change = changes[i];
      const end = change.from + change.inserted.length;
      if (change.from < 0 || end > doc.length || doc.slice(change.from, end) !== change.inserted) return false;
      doc = doc.slice(0, change.from) + change.removed + doc.slice(end);
    }
    return true;
  }
  for (const change of changes) {
    if (change.from < 0 || change.to > doc.length || change.from > change.to) return false;
    if (doc.slice(change.from, change.to) !== change.removed) return false;
    doc = doc.slice(0, change.from) + change.inserted + doc.slice(change.to);
  }
  return true;
}

function pushCap(stack, entry) {
  stack.push(entry);
  if (stack.length > STACK_CAP) stack.shift();
}

function producedFrom(next, state) {
  const changes = next !== state && next.doc !== state.doc && Array.isArray(next.changes) ? next.changes : [];
  return { doc: next.doc, cursor: next.cursor, anchor: next.anchor, changes };
}

function runOp(text, cursor, anchor, msg) {
  if (msg.op === "insert" || msg.op === "backspace" || msg.op === "delete" || msg.op === "move") {
    const state = createState(text, cursor, anchor);
    let next = state;
    if (msg.op === "insert") {
      next = insert(state, typeof msg.text === "string" ? msg.text : "");
      if (next && next !== state && Array.isArray(next.changes) && next.changes.length === 1
        && typeof msg.caret === "number" && Number.isFinite(msg.caret)) {
        const caret = Math.max(0, Math.min(next.doc.length, Math.trunc(msg.caret)));
        next = { ...next, cursor: caret, anchor: caret };
      }
    }
    else if (msg.op === "backspace") next = backspace(state);
    else if (msg.op === "delete") next = deleteForward(state);
    else next = moveText(state, msg.dest);
    if (next === null) return null;
    return producedFrom(next, state);
  }
  if (msg.op === "comment.add") {
    const result = addComment(text, anchor, cursor);
    if (!result) return null;
    return { doc: result.doc, cursor: result.cursor, anchor: result.cursor, changes: result.changes };
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
  return producedFrom(next, state);
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
  const raw = text.split("\n", 1)[0];
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  const match = /^#\s+(\S.*)$/.exec(line);
  if (!match) return "";
  return match[1].trim();
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

function ticketView(ticket, rev) {
  // The list has to carry the file rev. A child ticket.set names that file, not the open one.
  const fileRev = typeof rev === "number" && Number.isFinite(rev) ? rev : 0;
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
    rev: fileRev,
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

// Ambient GIT_DIR, GIT_WORK_TREE, or GIT_INDEX_FILE would name a different tree than root.
function gitAt(root, args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    execFile("git", args, { cwd: root, env }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(typeof stdout === "string" ? stdout : stdout.toString("utf8"));
    });
  });
}

async function isRegularFile(abs) {
  try {
    const info = await fs.lstat(abs);
    return info.isFile();
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

async function walkRegularFiles(abs, rel, out) {
  const entries = await fs.readdir(abs, { withFileTypes: true });
  for (const entry of entries) {
    const childRel = `${rel}/${entry.name}`;
    const childAbs = path.join(abs, entry.name);
    if (entry.isDirectory()) await walkRegularFiles(childAbs, childRel, out);
    else if (entry.isFile()) out.push(childRel);
  }
}

async function hashBuild(root) {
  const rels = [];
  for (const name of ["index.html", "editor.css"]) {
    if (await isRegularFile(path.join(root, name))) rels.push(name);
  }
  for (const dirName of ["src", "vendor"]) {
    const abs = path.join(root, dirName);
    let info;
    try {
      info = await fs.lstat(abs);
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }
    if (!info.isDirectory()) continue;
    await walkRegularFiles(abs, dirName, rels);
  }
  rels.sort();
  const hash = createHash("sha256");
  for (const rel of rels) {
    const bytes = await fs.readFile(path.join(root, ...rel.split("/")));
    hash.update(rel);
    hash.update("\0");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export async function readBuild(root) {
  try {
    const top = (await gitAt(root, ["rev-parse", "--show-toplevel"])).trim();
    const topReal = await fs.realpath(top);
    const rootReal = await fs.realpath(root);
    if (topReal === rootReal) {
      const head = (await gitAt(root, ["rev-parse", "HEAD"])).trim();
      if (/^[0-9a-f]{40}$/.test(head)) return head;
    }
  } catch {
    // Not this repository's toplevel. Hash the page sources instead.
  }
  try {
    return await hashBuild(root);
  } catch {
    return "";
  }
}

export async function createHub(stateDir, sourceRoot) {
  const build = await readBuild(sourceRoot);
  const repos = await loadRepos(stateDir);
  const sockets = new Set();
  // token -> socket that currently owns that page's caret. A live second socket is not stored.
  const sessionTokens = new Map();
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

  function fail(socket, status, extra) {
    const body = { type: "error", status };
    if (extra && typeof extra.heldBy === "string") body.heldBy = extra.heldBy;
    if (extra && typeof extra.reason === "string") body.reason = extra.reason;
    send(socket, body);
  }

  function failHeld(socket, wrote) {
    if (wrote && typeof wrote.heldBy === "string") return fail(socket, 409, { heldBy: wrote.heldBy });
    return fail(socket, 409);
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

  // Claims are previewed on copies. A span another socket holds aborts before the write.
  function replayClaims(socket, file, before, changes, mode) {
    const sets = new Map();
    for (const sock of file.subscribers) sets.set(sock, new Set(sock.session.lines));
    if (!sets.has(socket)) sets.set(socket, new Set(socket.session.lines));
    let doc = before;
    const claims = mode === "edit" || mode === "comment" || mode === "diff" || mode === "history";
    for (const change of changes) {
      const touched = touchedIndices(doc, change);
      const actor = sets.get(socket);
      for (const index of touched.hit) {
        for (const [sock, lines] of sets) {
          if (sock !== socket && lines.has(index)) return { heldBy: sock.session.username };
        }
        if (claims) actor.add(index);
      }
      for (const [sock, lines] of [...sets]) sets.set(sock, rebaseLineSet(lines, touched, change));
      doc = applyOne(doc, change);
    }
    return { doc, sets };
  }

  async function publish(socket, file, before, changes, caret, entry, mode, retain) {
    const preview = replayClaims(socket, file, before, changes, mode);
    if (preview.heldBy) return { heldBy: preview.heldBy };
    const after = preview.doc;
    if (file.ticket) {
      const composed = composeTicket({ ...file.ticket, id: file.ticket.id, body: after });
      if (composed == null) return false;
      await writeAtomic(file.full, composed);
    } else {
      await writeAtomic(file.full, after);
    }
    file.text = after;
    file.rev += 1;
    for (const [sock, lines] of preview.sets) sock.session.lines = lines;
    for (const change of changes) {
      for (const sock of file.subscribers) {
        if (sock !== socket) {
          sock.session.cursor = shiftOffset(sock.session.cursor, change.from, change.to, change.inserted.length);
          sock.session.anchor = shiftOffset(sock.session.anchor, change.from, change.to, change.inserted.length);
        }
        rebaseStack(sock.session.undo, change, "undo", entry);
        rebaseStack(sock.session.redo, change, "redo", entry);
      }
      if (!file.subscribers.has(socket)) {
        rebaseStack(socket.session.undo, change, "undo", entry);
        rebaseStack(socket.session.redo, change, "redo", entry);
      }
    }
    socket.session.cursor = caret.cursor;
    socket.session.anchor = caret.anchor;
    mark(socket.session.repo, file.rel, socket.session.username);
    // The preparatory lock covers every span the change list claimed.
    // Keep the caret line so the rest can be taken, unless that line is still
    // someone else's. A ranged diff keeps every splice span instead.
    if (!retain) {
      const caretLines = touchedLines(file.text, caret.cursor, caret.cursor);
      const kept = new Set();
      for (const index of caretLines) {
        let taken = false;
        for (const sock of file.subscribers) {
          if (sock !== socket && sock.session.lines.has(index)) taken = true;
        }
        if (!taken) kept.add(index);
      }
      socket.session.lines = kept;
    }
    syncLocks(file);
    const wire = changes.map((change) => ({ from: change.from, to: change.to, inserted: change.inserted }));
    const body = {
      type: "doc",
      path: file.rel,
      rev: file.rev,
      text: file.text,
      changes: wire,
      actor: socket.session.username,
      cursor: caret.cursor,
      anchor: caret.anchor,
    };
    if (wire.length === 1) {
      body.from = wire[0].from;
      body.to = wire[0].to;
      body.inserted = wire[0].inserted;
    }
    broadcast(file, body);
    broadcast(file, {
      type: "locks",
      path: file.rel,
      rev: file.rev,
      lines: lockSnapshot(file),
    });
    // titlesFor reads the cached text, which is assigned above.
    if (!file.ticket && headingTitle(before) !== headingTitle(after)) {
      broadcastDocs(socket.session.repo, await docsPayload(socket.session.repo));
    }
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
        ticket: ticketView(parsed, 0),
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
        if (cached.ticket) tickets.push(ticketView(cached.ticket, cached.rev));
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
      tickets.push(ticketView(parsed, 0));
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
    if (file.ticket) message.ticket = ticketView(file.ticket, file.rev);
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

  async function onRev(socket, msg) {
    const repo = socket.session.repo;
    if (!repo) return fail(socket, 400);
    const rel = safeRel(msg.path);
    if (!rel) return fail(socket, 404);
    const cached = repo.files.get(rel);
    let bytes;
    if (cached) bytes = Buffer.from(cached.text, "utf8");
    else {
      const full = path.resolve(repo.path, rel);
      let real;
      try { real = await fs.realpath(full); }
      catch { return fail(socket, 404); }
      if (!inside(repo.path, real)) return fail(socket, 404);
      let info;
      try { info = await fs.stat(real); }
      catch { return fail(socket, 404); }
      if (!info.isFile()) return fail(socket, 404);
      bytes = await fs.readFile(real);
    }
    send(socket, { type: "rev", path: rel, sha256: createHash("sha256").update(bytes).digest("hex") });
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
    const replyMoved = () => {
      send(socket, { type: "moved", path: rel, moves: pairs.map((pair) => ({ path: pair.src, dest: pair.dest })) });
    };
    if (pairs.every((pair) => pair.src === pair.dest)) {
      replyMoved();
      return;
    }

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
    replyMoved();
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
    const already = session.docPath === rel;
    if (!already) {
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
    // A fresh open has no caret yet. Reopening the file this socket holds
    // returns the caret so a replayed edit lands where the session left it.
    if (already) {
      message.cursor = session.cursor;
      message.anchor = session.anchor;
    }
    if (file.ticket) message.ticket = ticketView(file.ticket, file.rev);
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
    let text = "";
    if (Object.prototype.hasOwnProperty.call(msg, "text")) {
      if (typeof msg.text !== "string") return fail(socket, 400);
      text = msg.text;
    }
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
    await writeAtomic(dest, text);
    files.set(rel, { rel, full: dest, rev: 0, text, subscribers: new Set(), locks: new Map() });
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
    const parsed = parseTicket(file.ticket.id, composed);
    if (!parsed) return fail(socket, 400);
    const reason = rejectLink(await collectTickets(repo), parsed.id, parsed.parent, parsed.depends);
    if (reason) return fail(socket, 409);
    const current = composeTicket({ ...file.ticket, body: file.text });
    if (composed === current) return;
    await writeAtomic(file.full, composed);
    file.rev += 1;
    file.ticket = ticketView(parsed, file.rev);
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
      cached.rev += 1;
      cached.ticket = ticketView(next, cached.rev);
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

  function otherHolder(repo, rel, socket) {
    for (const sock of sockets) {
      if (sock === socket || !sock.session || sock.session.repo !== repo) continue;
      if (sock.session.docPath === rel) return sock.session.username;
    }
    const file = repo.files.get(rel);
    if (!file) return null;
    for (const owner of file.locks.values()) {
      if (owner && owner !== socket) return owner.session.username;
    }
    return null;
  }

  // The requester may still have the file open. Removal is not an edit: no undo entry and no commit.
  async function unlinkFile(socket, rel) {
    const repo = socket.session.repo;
    if (socket.session.docPath === rel) await releaseFile(socket);
    const cached = repo.files.get(rel);
    repo.files.delete(rel);
    await fs.rm(cached ? cached.full : path.join(repo.path, rel), { force: true });
    await markDelete(repo, rel, socket.session.username);
    send(socket, { type: "deleted", path: rel });
    broadcastDocs(repo, await docsPayload(repo));
  }

  async function onDelete(socket, msg) {
    const repo = socket.session.repo;
    if (!repo) return fail(socket, 400);
    const rel = safeRel(msg.path);
    if (!rel) return fail(socket, 404);
    if (isTicketTree(rel)) return fail(socket, 400);
    const listed = await listMarkdown(repo.path, "");
    if (!listed.includes(rel)) return fail(socket, 404);
    const holder = otherHolder(repo, rel, socket);
    if (holder) return fail(socket, 409, { heldBy: holder });
    await unlinkFile(socket, rel);
  }

  async function onTicketDelete(socket, msg) {
    const repo = socket.session.repo;
    if (!repo) return fail(socket, 400);
    const id = typeof msg.id === "string" ? msg.id : "";
    const rel = `tickets/${id}.md`;
    if (!ticketIdFromRel(rel)) return fail(socket, 404);
    const all = await collectTickets(repo);
    if (!all.some((ticket) => ticket.id === id)) return fail(socket, 404);
    const holder = otherHolder(repo, rel, socket);
    if (holder) return fail(socket, 409, { heldBy: holder });
    await unlinkFile(socket, rel);
    for (const ticket of all) {
      if (ticket.id === id) continue;
      const parent = ticket.parent === id ? "" : ticket.parent;
      const depends = ticket.depends.filter((dep) => dep !== id);
      if (parent === ticket.parent && depends.length === ticket.depends.length) continue;
      await rewriteTicketLinks(repo, ticket.id, parent, depends, socket.session.username);
    }
    await broadcastTickets(repo);
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
      if (owner && owner !== socket) return fail(socket, 409, { heldBy: owner.session.username });
    }
    session.lines = nextLines;
    session.anchor = anchor;
    session.cursor = cursor;
    syncLocks(file);
    broadcast(file, { type: "locks", path: file.rel, rev: file.rev, lines: lockSnapshot(file) });
  }

  function failDoc(socket, status, file, extra) {
    const body = { type: "error", status, path: file.rel, rev: file.rev, text: file.text };
    if (extra && typeof extra.heldBy === "string" && extra.heldBy) body.heldBy = extra.heldBy;
    if (extra && typeof extra.reason === "string") body.reason = extra.reason;
    send(socket, body);
  }

  function holderOf(file, socket, splices) {
    for (const splice of splices) {
      for (const index of touchedIndices(file.text, splice).hit) {
        const owner = file.locks.get(index);
        if (owner && owner !== socket) return owner.session.username;
      }
    }
    return null;
  }

  async function ensureSubscribed(socket, file) {
    const session = socket.session;
    if (session.docPath !== file.rel) {
      await releaseFile(socket);
      session.docPath = file.rel;
      session.anchor = 0;
      session.cursor = 0;
      session.lines = new Set();
      session.undo = [];
      session.redo = [];
    }
    file.subscribers.add(socket);
  }

  async function onDiff(socket, msg) {
    const repo = socket.session.repo;
    if (!repo) return fail(socket, 400);
    const rel = safeRel(msg.path);
    if (!rel) return fail(socket, 404);
    if (rel === "tickets" || (rel.startsWith("tickets/") && !ticketIdFromRel(rel))) return fail(socket, 404);
    const file = await loadFile(repo, rel);
    if (!file) return fail(socket, 404);
    if (typeof msg.diff !== "string") return fail(socket, 400);
    const parsed = parseUnifiedDiff(msg.diff);
    if (parsed.error) return fail(socket, 400);
    if (parsed.hunks.length === 0) {
      send(socket, { type: "file", path: file.rel, rev: file.rev, text: file.text });
      return;
    }
    let startOff = 0;
    let endOff = file.text.length;
    if (msg.start !== undefined || msg.end !== undefined) {
      const start = linePosition(msg.start);
      const end = linePosition(msg.end);
      if (!start || !end) return fail(socket, 400);
      const from = offsetAt(file.text, start.line, start.offset);
      const to = offsetAt(file.text, end.line, end.offset);
      if (from.error || to.error) return fail(socket, 400);
      startOff = Math.min(from.offset, to.offset);
      endOff = Math.max(from.offset, to.offset);
    }
    const plan = planDiff(file.text, parsed.hunks, startOff, endOff);
    if (plan.error === "context") return failDoc(socket, 409, file, { reason: "context" });
    if (plan.error === "matches") {
      send(socket, { type: "error", status: 2, reason: "matches", matches: plan.matches });
      return;
    }
    if (plan.error === "overlap") {
      send(socket, { type: "error", status: 2, reason: "overlap" });
      return;
    }
    const splices = plan.splices.slice().sort((a, b) => b.from - a.from || b.to - a.to);
    const holder = holderOf(file, socket, splices);
    if (holder) return failDoc(socket, 409, file, { reason: "conflict", heldBy: holder });
    if (splices.length === 0) {
      send(socket, { type: "file", path: file.rel, rev: file.rev, text: file.text });
      return;
    }
    await ensureSubscribed(socket, file);
    const held = new Set();
    for (const splice of splices) {
      for (const index of touchedIndices(file.text, splice).hit) held.add(index);
    }
    socket.session.lines = held;
    syncLocks(file);
    for (const splice of splices) {
      const caret = splice.from + splice.inserted.length;
      const wrote = await publish(
        socket,
        file,
        file.text,
        [{
          from: splice.from,
          to: splice.to,
          inserted: splice.inserted,
          removed: file.text.slice(splice.from, splice.to),
        }],
        { cursor: caret, anchor: caret },
        null,
        "diff",
        true,
      );
      if (wrote !== true) {
        const heldBy = wrote && typeof wrote.heldBy === "string" ? wrote.heldBy : "";
        return failDoc(socket, 409, file, heldBy ? { reason: "conflict", heldBy } : { reason: "conflict" });
      }
    }
    send(socket, { type: "file", path: file.rel, rev: file.rev, text: file.text });
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
    const changes = produced && Array.isArray(produced.changes) ? produced.changes : [];
    if (produced === undefined || produced === null || changes.length === 0 || produced.doc === file.text) {
      const reason = produced === null && msg.op === "comment.add"
        ? commentRangeReason(file.text, session.anchor, session.cursor)
        : null;
      session.cursor = savedCursor;
      session.anchor = savedAnchor;
      if (produced === undefined) return fail(socket, 400);
      if (produced === null) return reason ? fail(socket, 409, { reason }) : fail(socket, 409);
      // The bytes did not change, so rev and disk stay and nobody else hears a doc.
      send(socket, { type: "noop", path: file.rel, rev: file.rev });
      return;
    }
    const entry = {
      changes: copyChanges(changes),
      cursor: session.cursor,
      anchor: session.anchor,
      cursorAfter: produced.cursor,
      anchorAfter: produced.anchor,
      poison: false,
    };
    // comment.save, resolve, and delete rewrite the fence after the caret
    // hold has shrunk. edit claims every free span the change list touches.
    const mode = msg.op === "comment.save" || msg.op === "comment.resolve" || msg.op === "comment.delete"
      ? "comment"
      : "edit";
    const wrote = await publish(
      socket,
      file,
      file.text,
      changes,
      { cursor: produced.cursor, anchor: produced.anchor },
      null,
      mode,
    );
    if (wrote !== true) {
      session.cursor = savedCursor;
      session.anchor = savedAnchor;
      return failHeld(socket, wrote);
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
    if (!entry) {
      send(socket, { type: "noop", path: file.rel, rev: file.rev });
      return;
    }
    if (entry.poison || !Array.isArray(entry.changes) || !changesApply(file.text, entry.changes, direction)) {
      return fail(socket, 409);
    }
    const changes = direction === "undo" ? inverseChanges(entry.changes) : copyChanges(entry.changes);
    const caret = direction === "undo"
      ? { cursor: entry.cursor, anchor: entry.anchor }
      : { cursor: entry.cursorAfter, anchor: entry.anchorAfter };
    const wrote = await publish(socket, file, file.text, changes, caret, entry, "history");
    if (wrote !== true) return failHeld(socket, wrote);
    stack.pop();
    if (direction === "undo") pushCap(session.redo, entry);
    else pushCap(session.undo, entry);
  }

  function acceptedSession(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : "";
  }

  // The closed socket stays in file.subscribers until this runs, so an edit while it is
  // down still shifts its caret. onSelect returns immediately when repo is already set.
  function adoptSession(from, to) {
    const old = from.session;
    const next = to.session;
    if (!old || !next) return;
    next.lines = old.lines;
    next.cursor = old.cursor;
    next.anchor = old.anchor;
    next.undo = old.undo;
    next.redo = old.redo;
    next.docPath = old.docPath;
    next.repo = old.repo;
    const file = old.repo && old.docPath ? old.repo.files.get(old.docPath) : null;
    if (file) {
      file.subscribers.delete(from);
      file.subscribers.add(to);
      syncLocks(file);
    }
    old.adopted = true;
  }

  // A live socket keeps its own caret. The chain still records the newer
  // socket, so a later reconnect adopts that one after the older socket is gone.
  function adoptionSource(chain) {
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const sock = chain[i];
      const session = sock && sock.session;
      if (!session || session.adopted) continue;
      if (!sock.destroyed && !session.gone) continue;
      if (session.docPath || session.lines.size > 0 || session.undo.length > 0) return sock;
    }
    return null;
  }

  function claimSession(socket, token) {
    const chain = sessionTokens.get(token) || [];
    const source = adoptionSource(chain);
    if (source) adoptSession(source, socket);
    chain.push(socket);
    const kept = chain.filter((sock) => {
      if (sock === socket) return true;
      const session = sock && sock.session;
      if (!session) return false;
      const dead = sock.destroyed || session.gone;
      return !(dead && session.adopted);
    });
    sessionTokens.set(token, kept);
    socket.session.token = token;
  }

  async function disconnect(socket) {
    const session = socket.session;
    if (!session || session.gone) return;
    session.gone = true;
    sockets.delete(socket);
    // Still subscribed, so replayClaims and shiftOffset keep running. A later close of a
    // socket whose caret was already adopted must not release that file.
    if (session.token || session.adopted) return;
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

  // One-shot. Opening would subscribe this socket and leave it holding the document.
  async function loadCommentFile(socket, msg) {
    const repo = socket.session.repo;
    if (!repo) return { error: 400 };
    const rel = safeRel(msg.path);
    if (!rel) return { error: 404 };
    if (!commentPathAllowed(rel)) return { error: 400 };
    const file = await loadFile(repo, rel);
    if (!file) return { error: 404 };
    return { file };
  }

  function commentThread(file, id) {
    if (typeof id !== "string" || !COMMENT_ID.test(id)) return { error: 400 };
    const thread = commentThreads(file.text).find((item) => item.id === id);
    if (!thread) return { error: 404 };
    return { thread };
  }

  function sendComment(socket, file, threadId, noteId) {
    send(socket, { type: "comment", path: file.rel, id: threadId, note: noteId, rev: file.rev });
  }

  async function applyCommentBody(socket, file, threadId, body, noteId) {
    const before = createState(file.text);
    const produced = replaceCommentBody(before, threadId, body);
    if (produced === before || !Array.isArray(produced.changes) || produced.changes.length === 0) {
      sendComment(socket, file, threadId, noteId);
      return;
    }
    const wrote = await publish(socket, file, file.text, produced.changes, { cursor: 0, anchor: 0 }, null, "comment");
    if (wrote !== true) return failHeld(socket, wrote);
    sendComment(socket, file, threadId, noteId);
  }

  async function onCommentThreads(socket, msg) {
    const loaded = await loadCommentFile(socket, msg);
    if (loaded.error) return fail(socket, loaded.error);
    send(socket, {
      type: "comments",
      path: loaded.file.rel,
      rev: loaded.file.rev,
      threads: commentThreads(loaded.file.text).map(commentView),
    });
  }

  async function onCommentReply(socket, msg) {
    const loaded = await loadCommentFile(socket, msg);
    if (loaded.error) return fail(socket, loaded.error);
    const found = commentThread(loaded.file, msg.id);
    if (found.error) return fail(socket, found.error);
    if (typeof msg.text !== "string") return fail(socket, 400);
    const result = appendCommentReply(found.thread.body, msg.text, socket.session.username, new Date().toISOString());
    if (result.error) return fail(socket, result.error);
    await applyCommentBody(socket, loaded.file, msg.id, result.body, result.note.id);
  }

  async function onCommentEdit(socket, msg) {
    const loaded = await loadCommentFile(socket, msg);
    if (loaded.error) return fail(socket, loaded.error);
    const found = commentThread(loaded.file, msg.id);
    if (found.error) return fail(socket, found.error);
    if (typeof msg.note !== "number" || !Number.isInteger(msg.note) || msg.note < 0) return fail(socket, 400);
    if (typeof msg.text !== "string") return fail(socket, 400);
    const hasExpect = Object.prototype.hasOwnProperty.call(msg, "expect");
    if (hasExpect) {
      if (typeof msg.expect !== "string") return fail(socket, 400);
      const notes = parseCommentNotes(found.thread.body).filter((note) => note.id === msg.note);
      if (notes.length === 1 && splitCommentNote(notes[0].raw).text !== msg.expect) {
        return fail(socket, 409, { reason: "context" });
      }
    } else if (typeof msg.rev !== "number" || msg.rev !== loaded.file.rev) {
      return fail(socket, 409);
    }
    const result = reviseCommentNote(found.thread.body, msg.note, msg.text, socket.session.username);
    if (result.error) return fail(socket, result.error);
    if (result.unchanged) {
      sendComment(socket, loaded.file, msg.id, msg.note);
      return;
    }
    await applyCommentBody(socket, loaded.file, msg.id, result.body, result.note.id);
  }

  function denyUnlessAuthor(socket, thread) {
    const owner = noteZeroAuthor(thread.body);
    if (owner.error) return owner.error;
    if (owner.author !== socket.session.username) return 403;
    return 0;
  }

  async function onCommentResolve(socket, msg) {
    const loaded = await loadCommentFile(socket, msg);
    if (loaded.error) return fail(socket, loaded.error);
    const found = commentThread(loaded.file, msg.id);
    if (found.error) return fail(socket, found.error);
    if (typeof msg.resolved !== "boolean") return fail(socket, 400);
    const denied = denyUnlessAuthor(socket, found.thread);
    if (denied) return fail(socket, denied);
    const file = loaded.file;
    const before = createState(file.text);
    const produced = setCommentResolved(before, msg.id, msg.resolved);
    if (produced === before || !Array.isArray(produced.changes) || produced.changes.length === 0) {
      send(socket, {
        type: "comment",
        path: file.rel,
        id: msg.id,
        resolved: msg.resolved,
        rev: file.rev,
        unchanged: true,
      });
      return;
    }
    const wrote = await publish(socket, file, file.text, produced.changes, { cursor: 0, anchor: 0 }, null, "comment");
    if (wrote !== true) return failHeld(socket, wrote);
    send(socket, { type: "comment", path: file.rel, id: msg.id, resolved: msg.resolved, rev: file.rev });
  }

  async function onCommentDelete(socket, msg) {
    const loaded = await loadCommentFile(socket, msg);
    if (loaded.error) return fail(socket, loaded.error);
    const found = commentThread(loaded.file, msg.id);
    if (found.error) return fail(socket, found.error);
    const denied = denyUnlessAuthor(socket, found.thread);
    if (denied) return fail(socket, denied);
    const file = loaded.file;
    const before = createState(file.text);
    const produced = removeCommentThread(before, msg.id);
    if (produced === before || !Array.isArray(produced.changes) || produced.changes.length === 0) return fail(socket, 404);
    const wrote = await publish(socket, file, file.text, produced.changes, { cursor: 0, anchor: 0 }, null, "comment");
    if (wrote !== true) return failHeld(socket, wrote);
    send(socket, { type: "comment", path: file.rel, id: msg.id, rev: file.rev });
  }

  // The question is note 0 on the new fence. One publish writes the marks and
  // the note, or neither: a refused question must not leave an empty thread.
  function linePosition(value) {
    if (!value || typeof value !== "object") return null;
    if (!Number.isInteger(value.line) || !Number.isInteger(value.offset)) return null;
    return value;
  }

  async function onCommentAdd(socket, msg) {
    const loaded = await loadCommentFile(socket, msg);
    if (loaded.error) return fail(socket, loaded.error);
    const file = loaded.file;
    if (typeof msg.text !== "string") return fail(socket, 400);
    const start = linePosition(msg.start);
    const end = linePosition(msg.end);
    let anchor;
    let cursor;
    if (start && end) {
      const from = offsetAt(file.text, start.line, start.offset);
      const to = offsetAt(file.text, end.line, end.offset);
      if (from.error || to.error) return fail(socket, 400);
      anchor = from.offset;
      cursor = to.offset;
    } else if (!Number.isInteger(msg.anchor) || !Number.isInteger(msg.cursor)) {
      return fail(socket, 400);
    } else {
      anchor = msg.anchor;
      cursor = msg.cursor;
    }
    const hasExpect = Object.prototype.hasOwnProperty.call(msg, "expect");
    if (hasExpect) {
      if (typeof msg.expect !== "string") return fail(socket, 400);
      const lo = Math.min(anchor, cursor);
      const hi = Math.max(anchor, cursor);
      if (file.text.slice(lo, hi) !== msg.expect) return fail(socket, 409, { reason: "context" });
    } else if (typeof msg.rev !== "number" || msg.rev !== file.rev) {
      return fail(socket, 409);
    }
    const added = addComment(file.text, anchor, cursor);
    if (!added) {
      const reason = commentRangeReason(file.text, anchor, cursor);
      if (reason) return fail(socket, 409, { reason });
      return fail(socket, 409);
    }
    const thread = commentThreads(added.doc).find((item) => item.id === added.id);
    if (!thread) return fail(socket, 409);
    const reply = appendCommentReply(thread.body, msg.text, socket.session.username, new Date().toISOString());
    if (reply.error) return fail(socket, reply.error);
    const replaced = replaceCommentBody(createState(added.doc, added.cursor, added.cursor), added.id, reply.body);
    const changes = added.changes.concat(Array.isArray(replaced.changes) ? replaced.changes : []);
    if (changes.length === 0 || replaced.doc === file.text) return fail(socket, 409);
    const wrote = await publish(
      socket,
      file,
      file.text,
      changes,
      { cursor: replaced.cursor, anchor: replaced.anchor },
      null,
      "comment",
    );
    if (wrote !== true) return failHeld(socket, wrote);
    sendComment(socket, file, added.id, reply.note.id);
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
      const token = acceptedSession(msg.session);
      if (token) claimSession(socket, token);
      send(socket, { type: "hello", build });
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
    if (msg.type === "comment.threads") return onCommentThreads(socket, msg);
    if (msg.type === "comment.reply") return onCommentReply(socket, msg);
    if (msg.type === "comment.edit") return onCommentEdit(socket, msg);
    if (msg.type === "comment.resolve") return onCommentResolve(socket, msg);
    if (msg.type === "comment.delete") return onCommentDelete(socket, msg);
    if (msg.type === "comment.add") return onCommentAdd(socket, msg);
    if (msg.type === "list") return onList(socket);
    if (msg.type === "move") return onMove(socket, msg);
    if (msg.type === "rev") return onRev(socket, msg);
    if (msg.type === "open") return onOpen(socket, msg);
    if (msg.type === "create") return onCreate(socket, msg);
    if (msg.type === "tickets") return onTickets(socket);
    if (msg.type === "ticket.create") return onTicketCreate(socket, msg);
    if (msg.type === "ticket.set") return onTicketSet(socket, msg);
    if (msg.type === "ticket.purge") return onTicketPurge(socket);
    if (msg.type === "delete") return onDelete(socket, msg);
    if (msg.type === "ticket.delete") return onTicketDelete(socket, msg);
    if (msg.type === "lock") return onLock(socket, msg);
    if (msg.type === "diff") return onDiff(socket, msg);
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
    socket.on("end", () => {
      // The peer stopped sending. Until destroy, readyState stays writeOnly, so a
      // new hello still sees this socket as live and will not take its caret.
      if (!socket.destroyed) socket.destroy();
    });
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
    build,
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
