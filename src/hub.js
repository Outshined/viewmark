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
  insertLiteral,
  moveText,
  lockIndexAt,
  lockSpans,
  addressEnd,
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
  parseTicketToken,
  REPO_NAME,
  rejectLink,
  dropStoredMissing,
} from "./ticket.js";
import { MAX_PAYLOAD, acceptKey, createParser, encodeFrame, encodeText } from "./ws.js";

const PING_MS = 15000;
const STACK_CAP = 200;

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
  const entries = await fs.readdir(real);
  if (entries.length === 0) await seedEmptyWorkTree(real, sourceRoot);
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

// A directory symlink is part of the tree, including one whose target is outside
// the root. The path inside the root is the document path. A cycle ends that
// descent. A symlink that is not a directory is not a document.
async function directoryReal(full, stack) {
  let info;
  try {
    info = await fs.stat(full);
  } catch {
    return null;
  }
  if (!info.isDirectory()) return null;
  let real;
  try {
    real = await fs.realpath(full);
  } catch {
    return null;
  }
  if (stack.includes(real)) return null;
  return real;
}

function realInTicketStore(rootReal, candidate) {
  const rel = path.relative(rootReal, candidate);
  return rel === "tickets" || rel.startsWith(`tickets${path.sep}`);
}

// The literal tickets/ store stays reachable. Another path whose real
// directory is that store is not a document path.
function storeStepAllowed(rootDir, rootReal, next, real) {
  if (!realInTicketStore(rootReal, real)) return true;
  const walked = path.relative(rootDir, next).split(path.sep).join("/");
  return walked === "tickets" || walked.startsWith("tickets/");
}

async function descend(rootDir, parts) {
  let rootReal;
  try {
    rootReal = await fs.realpath(rootDir);
  } catch {
    return null;
  }
  const stack = [rootReal];
  let logical = rootDir;
  for (let i = 0; i < parts.length; i += 1) {
    const next = path.join(logical, parts[i]);
    let listed;
    try {
      listed = await fs.lstat(next);
    } catch (err) {
      if (err && err.code === "ENOENT") return { logical, stack, rootReal, index: i, missing: true };
      return null;
    }
    if (!listed.isDirectory() && !listed.isSymbolicLink()) return null;
    const real = await directoryReal(next, stack);
    if (!real || !storeStepAllowed(rootDir, rootReal, next, real)) return null;
    stack.push(real);
    logical = next;
  }
  return { logical, stack, rootReal, index: parts.length, missing: false };
}

async function walkTree(rootDir, rel) {
  const parts = rel.split("/");
  const base = parts.pop();
  const descended = await descend(rootDir, parts);
  if (!descended || descended.missing) return null;
  const next = path.join(descended.logical, base);
  let listed;
  try {
    listed = await fs.lstat(next);
  } catch {
    return null;
  }
  if (listed.isDirectory() || listed.isSymbolicLink()) {
    const real = await directoryReal(next, descended.stack);
    if (!real || !storeStepAllowed(rootDir, descended.rootReal, next, real)) return null;
    return { logical: next, real, kind: listed.isSymbolicLink() ? "dir-link" : "dir" };
  }
  if (!listed.isFile()) return null;
  let real;
  try {
    real = await fs.realpath(next);
  } catch {
    return null;
  }
  if (realInTicketStore(descended.rootReal, real) && ticketIdFromRel(rel) == null) return null;
  return { logical: next, real, kind: "file" };
}

async function createDest(rootDir, rel) {
  const parts = rel.split("/");
  const base = parts.pop();
  const descended = await descend(rootDir, parts);
  if (!descended) return null;
  let logical = descended.logical;
  if (descended.missing) {
    logical = path.join(logical, ...parts.slice(descended.index));
    try {
      await fs.mkdir(logical, { recursive: true });
    } catch {
      return null;
    }
  }
  let parentReal;
  try {
    parentReal = await fs.realpath(logical);
  } catch {
    return null;
  }
  if (!storeStepAllowed(rootDir, descended.rootReal, logical, parentReal)) return null;
  return path.join(parentReal, base);
}

async function resolveInside(rootDir, rel) {
  const found = await walkTree(rootDir, rel);
  if (!found) return null;
  // The name inside the root is what moves. A file under a directory link is
  // renamed through that link, so the bytes land on the real file.
  return found.logical;
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

// Pieces of a typed run are pure inserts in current-document coordinates, so a
// foreign insert can sit between them without poisoning the entry.
function pureInsertEntry(entry) {
  if (!entry || !Array.isArray(entry.changes) || entry.changes.length === 0) return false;
  for (const change of entry.changes) {
    if (!change || change.from !== change.to || change.removed !== "" || typeof change.inserted !== "string") return false;
  }
  return true;
}

// An insertion that ends at a change's from is before that change, not an overlap.
function rebaseUndoChanges(entry, ext, mode) {
  let eFrom = ext.from;
  let eTo = ext.to;
  const eLen = ext.inserted.length;
  // A pure insert strictly inside this session's inserted text stays after undo.
  const splittable = pureInsertEntry(entry) && eFrom === eTo && (ext.removed || "") === "";
  for (let i = entry.changes.length - 1; i >= 0; i -= 1) {
    const change = entry.changes[i];
    const regionEnd = change.from + change.inserted.length;
    // A forward delete stores no inserted text, so a later delete at that same
    // offset is past the region and leaves from put. Its undo is a pure history
    // insert on that index. shiftOffset leaves the index put; sliding it would
    // restore the earlier character on the wrong side. A delete that only ends
    // here, such as backspace, is not counted, so its undo still shifts.
    const historyAtFrom = mode === "history"
      && change.inserted === ""
      && eFrom === eTo
      && eTo === change.from
      && change.deletesAtFrom > 0;
    if (eTo <= change.from && !historyAtFrom) {
      const delta = eLen - (eTo - eFrom);
      change.from += delta;
      change.to += delta;
      continue;
    }
    if (historyAtFrom) change.deletesAtFrom -= 1;
    if (eFrom >= regionEnd) {
      if (change.inserted === "" && eFrom === regionEnd && eTo > eFrom && eLen === 0) {
        change.deletesAtFrom = (change.deletesAtFrom || 0) + 1;
      }
      const delta = change.removed.length - change.inserted.length;
      eFrom += delta;
      eTo += delta;
      continue;
    }
    if (splittable && eFrom > change.from && eFrom < regionEnd) {
      const at = eFrom - change.from;
      const tail = change.inserted.slice(at);
      change.inserted = change.inserted.slice(0, at);
      entry.changes.splice(i + 1, 0, {
        from: eFrom + eLen,
        to: eFrom + eLen,
        inserted: tail,
        removed: "",
      });
      continue;
    }
    return false;
  }
  return true;
}

// The next key of a run appends at the caret this entry already leaves behind.
function canFoldTyping(entry, changes) {
  if (!entry || entry.poison || !Array.isArray(entry.changes) || entry.changes.length !== 1) return false;
  if (!Array.isArray(changes) || changes.length !== 1) return false;
  const next = changes[0];
  const prev = entry.changes[0];
  if (!next || !prev || typeof prev.inserted !== "string") return false;
  if (typeof next.inserted !== "string" || next.inserted === "") return false;
  if (next.removed !== "" || next.from !== next.to) return false;
  const at = prev.from + prev.inserted.length;
  return next.from === at && next.to === at;
}

// group means this splice belongs to the open entry, even when it is not an append.
function canFoldGroup(entry, changes) {
  if (!entry || entry.poison) return false;
  if (!Array.isArray(entry.changes) || entry.changes.length === 0) return false;
  if (!Array.isArray(changes) || changes.length === 0) return false;
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
function rebaseStack(stack, change, kind, skip, mode) {
  for (const entry of stack) {
    if (entry === skip || entry.poison) continue;
    const ok = kind === "undo" ? rebaseUndoChanges(entry, change, mode) : rebaseRedoChanges(entry, change);
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
      const typed = typeof msg.text === "string" ? msg.text : "";
      next = insert(state, typed, msg.paste === true, msg.raw === true, msg.exact === true);
      // exact names the bytes. A refusal is not rewritten as a raw insert.
      if (next === null && msg.raw === true && msg.exact !== true) next = insertLiteral(state, typed);
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

async function listMarkdown(dir, prefix = "", stack = null) {
  if (stack == null) {
    let rootReal;
    try {
      rootReal = await fs.realpath(dir);
    } catch {
      return [];
    }
    // The root is already on the descent, so a link back to it ends there.
    stack = [rootReal];
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  const rootReal = stack[0];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      // tickets/ is the ticket store, not a document tree. A link of that name is the store too.
      if (prefix === "" && entry.name === "tickets") continue;
      const real = await directoryReal(full, stack);
      if (!real || realInTicketStore(rootReal, real)) continue;
      stack.push(real);
      try {
        out.push(...await listMarkdown(full, rel, stack));
      } finally {
        stack.pop();
      }
      continue;
    }
    if (entry.isFile() && isMarkdownPath(rel)) out.push(rel);
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

// A bare id and this repo's repo:id name the removed ticket. Another repo's
// token is a different ticket, and that repo's files are not written.
function namesRemoved(token, ids, repoName) {
  if (typeof token !== "string" || token === "") return false;
  if (ids.has(token)) return true;
  const parsed = parseTicketToken(token);
  return Boolean(parsed && parsed.repo === repoName && ids.has(parsed.id));
}

function clearedParent(parent, ids, repoName) {
  return namesRemoved(parent, ids, repoName) ? "" : parent;
}

function clearedDepends(depends, ids, repoName) {
  return depends.filter((dep) => !namesRemoved(dep, ids, repoName));
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

function validAssignee(value) {
  if (typeof value !== "string" || /[\r\n\t]/.test(value)) return null;
  return value.trim();
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
    assignee: typeof ticket.assignee === "string" ? ticket.assignee : "",
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
    assignee: typeof ticket.assignee === "string" ? ticket.assignee : "",
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
    return await hashBuild(root);
  } catch {
    return "";
  }
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

// tickets/<id>.md owns tickets/<id>/. notes/welcome.md owns notes/welcome/.
// tickets.md does not own tickets/: that directory is the ticket store.
export function assetDirOf(rel) {
  if (typeof rel !== "string") return null;
  let dir = null;
  if (rel.endsWith(".markdown")) dir = rel.slice(0, -".markdown".length);
  else if (rel.endsWith(".md")) dir = rel.slice(0, -3);
  if (dir === "tickets") return null;
  return dir;
}

export function imageKind(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_PAYLOAD) return null;
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 6) {
    const sig = bytes.subarray(0, 6).toString("ascii");
    if (sig === "GIF87a" || sig === "GIF89a") return "gif";
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "webp";
  }
  return null;
}

// A taken id is drawn again. Eight draws is the same cap as a new ticket.
export function allocateImageId(taken, random = Math.random) {
  const hold = typeof taken === "function" ? taken : () => false;
  for (let draw = 0; draw < 8; draw += 1) {
    const id = generateId(random);
    if (!hold(id)) return id;
  }
  return null;
}

function sourceLines(doc) {
  const text = typeof doc === "string" ? doc : "";
  const lines = [];
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text[i] === "\n") {
      const cr = i > start && text[i - 1] === "\r";
      lines.push({
        start,
        end: i,
        text: text.slice(start, cr ? i - 1 : i),
        nl: i < text.length,
      });
      start = i + 1;
      if (i === text.length) break;
    }
  }
  if (lines.length > 1 && lines[lines.length - 1].start === text.length) lines.pop();
  return lines;
}

function fenceOpenLine(text) {
  return /^```[ \t]*([^`\s]*)/.test(text);
}

function fenceCloseLine(text) {
  return /^```[ \t]*$/.test(text);
}

function delimiterRow(text) {
  let body = text.trim();
  if (!body.includes("-")) return false;
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  const cells = body.split("|");
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function tableStartLine(lines, index) {
  if (index + 1 >= lines.length) return false;
  const header = lines[index].text;
  if (!header.includes("|") || delimiterRow(header)) return false;
  return delimiterRow(lines[index + 1].text);
}

function tableBodyLine(text) {
  return text.trim() !== "" && text.includes("|");
}

function enclosingFence(lines, index) {
  let i = 0;
  while (i < lines.length) {
    if (!fenceOpenLine(lines[i].text)) {
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !fenceCloseLine(lines[end].text)) end += 1;
    const last = end < lines.length ? end : lines.length - 1;
    if (index >= i && index <= last) return { from: i, to: last };
    i = last + 1;
  }
  return null;
}

function enclosingTable(lines, index) {
  let i = 0;
  while (i < lines.length) {
    if (!tableStartLine(lines, i)) {
      i += 1;
      continue;
    }
    let end = i + 2;
    while (end < lines.length && tableBodyLine(lines[end].text)) end += 1;
    const last = end - 1;
    if (index >= i && index <= last) return { from: i, to: last };
    i = end;
  }
  return null;
}

function lineIndexAtOffset(lines, offset) {
  for (let i = 0; i < lines.length; i += 1) {
    if (offset >= lines[i].start && offset <= lines[i].end) return i;
  }
  return lines.length - 1;
}

function afterLine(line) {
  if (!line) return 0;
  return line.nl ? line.end + 1 : line.end;
}

function afterSpan(doc, span) {
  if (!span) return doc.length;
  if (span.end < doc.length && doc[span.end] === "\n") return span.end + 1;
  return span.end;
}

// The picture follows the block that holds the point. A fence or a table is one block,
// so the line does not land inside a comment note or between table rows.
function insertionAt(doc, offset) {
  const text = typeof doc === "string" ? doc : "";
  const lines = sourceLines(text);
  if (offset == null) {
    if (lines.length === 0) return 0;
    return afterLine(lines[lines.length - 1]);
  }
  const at = Math.max(0, Math.min(text.length, offset));
  if (lines.length === 0) return 0;
  const index = lineIndexAtOffset(lines, at);
  const fence = enclosingFence(lines, index);
  if (fence) return afterLine(lines[fence.to]);
  const table = enclosingTable(lines, index);
  if (table) return afterLine(lines[table.to]);
  const spans = lockSpans(text);
  let span = null;
  for (const item of spans) {
    if (at >= item.start && at <= item.end) {
      span = item;
      break;
    }
  }
  if (!span) span = spans[spans.length - 1] || null;
  return afterSpan(text, span);
}

// One blank line on each side when a neighbor is there. The caret sits just after the image line.
export function imagePlacement(doc, offset, imageLine) {
  const text = typeof doc === "string" ? doc : "";
  const line = typeof imageLine === "string" ? imageLine : "";
  const at = insertionAt(text, offset);
  let gapStart = at;
  while (gapStart > 0 && text[gapStart - 1] === "\n") gapStart -= 1;
  let gapEnd = at;
  while (gapEnd < text.length && text[gapEnd] === "\n") gapEnd += 1;
  const before = text.slice(0, gapStart);
  const after = text.slice(gapEnd);
  let inserted;
  if (before.length === 0 && after.length === 0) inserted = `${line}\n`;
  else if (before.length === 0) inserted = `${line}\n\n`;
  else if (after.length === 0) inserted = `\n\n${line}\n`;
  else inserted = `\n\n${line}\n\n`;
  // The extra newline after the image line separates the following block. The caret
  // sits just past the image line, so that line stays drawn.
  const caret = before.length + inserted.length - (after.length === 0 ? 0 : 1);
  return {
    from: gapStart,
    to: gapEnd,
    inserted,
    removed: text.slice(gapStart, gapEnd),
    caret,
    doc: before + inserted + after,
  };
}

function touchedSpans(doc, lo, hi) {
  const spans = lockSpans(doc);
  const hit = [];
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index];
    const covers = lo === hi ? lo >= span.start && lo <= span.end : lo <= span.end && hi > span.start;
    if (covers) hit.push(index);
  }
  return { spans, hit };
}

function blankSpan(doc, span) {
  return !!span && span.start === span.end && doc[span.start] === "\n";
}

// A caret on the blank line between two paragraphs replaces that line. Any other
// range in one block follows that block. A range in two blocks is refused.
export function imageRangePlacement(doc, lo, hi, imageLine) {
  const text = typeof doc === "string" ? doc : "";
  const from = Math.min(lo, hi);
  const to = Math.max(lo, hi);
  if (from < 0 || to > text.length) return { error: 400 };
  const { spans, hit } = touchedSpans(text, from, to);
  if (hit.length !== 1) return { error: 400 };
  const index = hit[0];
  const span = spans[index];
  const line = typeof imageLine === "string" ? imageLine : "";
  const between = from === to && blankSpan(text, span) && index > 0 && index < spans.length - 1
    && !blankSpan(text, spans[index - 1]) && !blankSpan(text, spans[index + 1]);
  if (!between) return imagePlacement(text, from, line);
  const inserted = line;
  const caret = span.start + inserted.length + 1;
  return {
    from: span.start,
    to: span.start,
    inserted,
    removed: "",
    caret,
    doc: text.slice(0, span.start) + inserted + text.slice(span.start),
  };
}

export function imageLineFor(dir, file) {
  return `![${file}](${dir}/${file})`;
}

// Eight draws, same as a new ticket. A name already in the text or in occupied is skipped.
export function imageFileName(dir, ext, text, occupied, random = Math.random) {
  const blocked = new Set();
  const body = typeof text === "string" ? text : "";
  const hold = occupied instanceof Set ? occupied : new Set();
  for (let round = 0; round < 8; round += 1) {
    const id = allocateImageId((candidate) => blocked.has(candidate), random);
    if (!id) return null;
    const file = `${id}.${ext}`;
    const rel = `${dir}/${file}`;
    if (body.includes(`](${rel})`) || hold.has(file) || hold.has(rel)) {
      blocked.add(id);
      continue;
    }
    return { id, file, rel };
  }
  return null;
}

async function listAssetNames(rootDir, dirRel) {
  let entries;
  try {
    entries = await fs.readdir(path.join(rootDir, dirRel), { withFileTypes: true });
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return [];
    throw err;
  }
  const names = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    names.push(entry.name);
  }
  names.sort();
  return names;
}

// A space, a tab, or a parenthesis in a document name is part of the address.
function imageAddresses(text) {
  const found = [];
  if (typeof text !== "string") return found;
  let index = 0;
  while (index < text.length) {
    const bang = text.indexOf("![", index);
    if (bang < 0) break;
    const labelEnd = text.indexOf("]", bang + 2);
    if (labelEnd < 0 || text[labelEnd + 1] !== "(") {
      index = bang + 2;
      continue;
    }
    const urlEnd = addressEnd(text, labelEnd + 1);
    if (urlEnd < 0) {
      index = labelEnd + 2;
      continue;
    }
    found.push({ urlStart: labelEnd + 2, urlEnd, url: text.slice(labelEnd + 2, urlEnd) });
    index = urlEnd + 1;
  }
  return found;
}

function localImageUrl(url) {
  return typeof url === "string"
    && !url.startsWith("https://")
    && !url.startsWith("http://")
    && !url.startsWith("data:");
}

export function rewriteImageDirs(text, fromDir, toDir) {
  if (typeof text !== "string" || !fromDir || !toDir || fromDir === toDir) return text;
  const from = `${fromDir}/`;
  const to = `${toDir}/`;
  const parts = [];
  let index = 0;
  let changed = false;
  for (const item of imageAddresses(text)) {
    parts.push(text.slice(index, item.urlStart));
    if (!localImageUrl(item.url) || !item.url.startsWith(from)) parts.push(item.url);
    else {
      parts.push(`${to}${item.url.slice(from.length)}`);
      changed = true;
    }
    index = item.urlEnd;
  }
  if (!changed) return text;
  parts.push(text.slice(index));
  return parts.join("");
}

function referencedImageNames(text, dir) {
  const names = new Set();
  if (!dir) return names;
  const prefix = `${dir}/`;
  for (const item of imageAddresses(text)) {
    if (!localImageUrl(item.url) || !item.url.startsWith(prefix)) continue;
    const name = item.url.slice(prefix.length);
    if (name.length > 0 && !name.includes("/")) names.add(name);
  }
  return names;
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

  function lockSnapshot(file) {
    const lines = [];
    for (const [index, owner] of file.locks) {
      // Two tabs share a username. The hello token is which tab holds the block.
      // A CLI socket has none, so a tab does not treat that lock as its own.
      const line = { index, username: owner.session.username };
      if (owner.session.token) line.token = owner.session.token;
      lines.push(line);
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

  // A gone page is parked, not subscribed, so its lines do not hold a block.
  // They still move with the document so a later hello adopts the shifted caret.
  function parkedSockets(file) {
    if (!file.suspended || file.suspended.size === 0) return [];
    const out = [];
    for (const sock of file.suspended) {
      if (!sock || !sock.session || file.subscribers.has(sock)) continue;
      out.push(sock);
    }
    return out;
  }

  // Claims are previewed on copies. A span another socket holds aborts before the write.
  function replayClaims(socket, file, before, changes, mode) {
    const sets = new Map();
    for (const sock of file.subscribers) sets.set(sock, new Set(sock.session.lines));
    if (!sets.has(socket)) sets.set(socket, new Set(socket.session.lines));
    const parked = new Map();
    for (const sock of parkedSockets(file)) {
      if (sock !== socket) parked.set(sock, new Set(sock.session.lines));
    }
    let doc = before;
    const claims = mode === "edit" || mode === "comment" || mode === "diff" || mode === "history";
    for (const change of changes) {
      const touched = touchedIndices(doc, change);
      const actor = sets.get(socket);
      for (const index of touched.hit) {
        for (const [sock, lines] of sets) {
          // The same token is this page, including a socket the navigation has not closed yet.
          if (!sameSession(sock, socket) && lines.has(index)) return { heldBy: sock.session.username };
        }
        if (claims) actor.add(index);
      }
      for (const [sock, lines] of [...sets]) sets.set(sock, rebaseLineSet(lines, touched, change));
      for (const [sock, lines] of [...parked]) parked.set(sock, rebaseLineSet(lines, touched, change));
      doc = applyOne(doc, change);
    }
    return { doc, sets, parked };
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
    for (const [sock, lines] of preview.parked) sock.session.lines = lines;
    for (const change of changes) {
      for (const sock of file.subscribers) {
        if (sock !== socket) {
          sock.session.cursor = shiftOffset(sock.session.cursor, change.from, change.to, change.inserted.length);
          sock.session.anchor = shiftOffset(sock.session.anchor, change.from, change.to, change.inserted.length);
        }
        rebaseStack(sock.session.undo, change, "undo", entry, mode);
        rebaseStack(sock.session.redo, change, "redo", entry, mode);
      }
      for (const sock of parkedSockets(file)) {
        if (sock === socket) continue;
        sock.session.cursor = shiftOffset(sock.session.cursor, change.from, change.to, change.inserted.length);
        sock.session.anchor = shiftOffset(sock.session.anchor, change.from, change.to, change.inserted.length);
        rebaseStack(sock.session.undo, change, "undo", entry, mode);
        rebaseStack(sock.session.redo, change, "redo", entry, mode);
      }
      if (!file.subscribers.has(socket)) {
        rebaseStack(socket.session.undo, change, "undo", entry, mode);
        rebaseStack(socket.session.redo, change, "redo", entry, mode);
      }
    }
    socket.session.cursor = caret.cursor;
    socket.session.anchor = caret.anchor;
    // The preparatory lock covers every span the change list claimed.
    // Keep the caret line so the rest can be taken, unless that line is still
    // someone else's. A ranged diff keeps every splice span instead.
    if (!retain) {
      const caretLines = touchedLines(file.text, caret.cursor, caret.cursor);
      const kept = new Set();
      for (const index of caretLines) {
        let taken = false;
        for (const sock of file.subscribers) {
          if (!sameSession(sock, socket) && sock.session.lines.has(index)) taken = true;
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
    if (socket.session.token) body.token = socket.session.token;
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

  // keep parks the caret for a later hello. Otherwise the session drops the document.
  async function dropSubscription(socket, keep) {
    const session = socket.session;
    const files = session?.repo?.files;
    if (!session || !files) return;
    const rel = session.docPath;
    if (!rel) return;
    const file = files.get(rel);
    if (!keep) {
      session.docPath = null;
      session.lines = new Set();
      session.undo = [];
      session.redo = [];
      session.anchor = 0;
      session.cursor = 0;
    }
    if (!file) return;
    file.subscribers.delete(socket);
    if (keep) {
      if (!file.suspended) file.suspended = new Set();
      file.suspended.add(socket);
    } else if (file.suspended) {
      file.suspended.delete(socket);
    }
    syncLocks(file);
    if (file.subscribers.size > 0) {
      broadcast(file, { type: "locks", path: file.rel, rev: file.rev, lines: lockSnapshot(file) });
    } else {
      await sweepUnreferencedImages(session.repo, file.rel, file.text);
    }
  }

  async function releaseFile(socket) {
    await dropSubscription(socket, false);
  }

  async function suspendFile(socket) {
    await dropSubscription(socket, true);
  }

  // The bytes stay while someone still has the document. A file no image line names goes away
  // with the last subscriber, so undo can put the line back and the picture is still there.
  async function sweepUnreferencedImages(repo, rel, text) {
    if (!repo || !rel) return;
    const dir = assetDirOf(rel);
    if (!dir) return;
    const keep = referencedImageNames(text, dir);
    const names = await listAssetNames(repo.path, dir);
    for (const name of names) {
      if (keep.has(name)) continue;
      await fs.rm(path.join(repo.path, dir, name), { force: true });
    }
  }

  async function removeAssetDir(repo, rel) {
    const dir = assetDirOf(rel);
    if (!dir || !repo) return;
    await fs.rm(path.join(repo.path, dir), { recursive: true, force: true });
  }

  async function prepareAssetDir(repo, dirRel) {
    const dest = await createDest(repo.path, `${dirRel}/x`);
    if (!dest) return null;
    return path.dirname(dest);
  }

  async function claimImageFile(repo, dir, ext, text) {
    const occupied = new Set();
    for (let round = 0; round < 8; round += 1) {
      const named = imageFileName(dir, ext, text, occupied);
      if (!named) return null;
      if (await existsPath(path.join(repo.path, named.rel))) {
        occupied.add(named.rel);
        continue;
      }
      return named;
    }
    return null;
  }

  // One page token is one session, even while a navigation still has the previous socket open.
  function sameSession(a, b) {
    if (a === b) return true;
    const token = a?.session?.token;
    return typeof token === "string" && token.length > 0 && token === b?.session?.token;
  }

  function holderAt(file, socket, offset) {
    if (offset == null || !file) return null;
    const spans = lockSpans(file.text);
    for (let index = 0; index < spans.length; index += 1) {
      const span = spans[index];
      if (offset < span.start || offset > span.end) continue;
      const owner = file.locks.get(index);
      if (owner && !sameSession(owner, socket)) return owner.session.username;
    }
    return null;
  }

  async function loadFile(repo, rel) {
    const files = repo.files;
    const docsDir = repo.path;
    const cached = files.get(rel);
    if (cached) return cached;
    const found = await walkTree(docsDir, rel);
    if (!found || found.kind !== "file") return null;
    const real = found.real;
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

  function tokenNamesRepo(token, repoName, ids) {
    const parsed = parseTicketToken(token);
    return Boolean(parsed && parsed.repo === repoName && ids.has(parsed.id));
  }

  // Tickets in other repos whose parent or depends names a ticket here.
  // A bare id belongs to the file's repo, so only repo:id counts.
  async function collectInbound(repo) {
    const tickets = await collectTickets(repo);
    const ids = new Set(tickets.map((ticket) => ticket.id));
    const inbound = [];
    for (const other of repos.values()) {
      if (other.name === repo.name) continue;
      const found = await collectTickets(other);
      for (const ticket of found) {
        const hit = tokenNamesRepo(ticket.parent, repo.name, ids)
          || ticket.depends.some((dep) => tokenNamesRepo(dep, repo.name, ids));
        if (!hit) continue;
        inbound.push({
          repo: other.name,
          id: ticket.id,
          title: ticket.title,
          parent: ticket.parent,
          depends: [...ticket.depends],
        });
      }
    }
    inbound.sort((a, b) => {
      if (a.repo < b.repo) return -1;
      if (a.repo > b.repo) return 1;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    return inbound;
  }

  // repo:id for every ticket this hub has. The page uses it to skip a missing
  // token. Titles travel on foreign, not on this set.
  async function presentTokens() {
    const tokens = [];
    for (const registered of repos.values()) {
      const found = await collectTickets(registered);
      for (const ticket of found) tokens.push(`${registered.name}:${ticket.id}`);
    }
    tokens.sort();
    return tokens;
  }

  // Every ticket in every other registered repo, so a page can title a token
  // and write that ticket without opening its repo.
  async function collectForeign(repo) {
    const foreign = [];
    for (const other of repos.values()) {
      if (other.name === repo.name) continue;
      const found = await collectTickets(other);
      for (const ticket of found) {
        foreign.push({
          repo: other.name,
          id: ticket.id,
          title: ticket.title,
          parent: typeof ticket.parent === "string" ? ticket.parent : "",
          depends: Array.isArray(ticket.depends) ? [...ticket.depends] : [],
          rev: typeof ticket.rev === "number" ? ticket.rev : 0,
        });
      }
    }
    foreign.sort((a, b) => {
      if (a.repo < b.repo) return -1;
      if (a.repo > b.repo) return 1;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    return foreign;
  }

  async function ticketsPayload(repo) {
    return {
      type: "tickets",
      tickets: await collectTickets(repo),
      inbound: await collectInbound(repo),
      present: await presentTokens(),
      foreign: await collectForeign(repo),
    };
  }

  async function linkIndex(home) {
    const names = [];
    const tickets = [];
    for (const registered of repos.values()) {
      names.push(registered.name);
      const found = await collectTickets(registered);
      for (const ticket of found) {
        tickets.push({
          repo: registered.name,
          id: ticket.id,
          parent: ticket.parent ?? "",
          depends: Array.isArray(ticket.depends) ? ticket.depends : [],
        });
      }
    }
    return { home: home.name, repos: names, tickets };
  }

  // A write changes what every open repo draws. Each repo gets its own frame.
  async function broadcastTickets() {
    const live = new Set();
    for (const sock of sockets) {
      if (sock.session?.repo) live.add(sock.session.repo);
    }
    for (const repo of live) {
      const msg = await ticketsPayload(repo);
      for (const sock of sockets) {
        if (sock.session?.repo === repo) send(sock, msg);
      }
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
    for (const sock of parkedSockets(file)) targets.add(sock);
    for (const sock of sockets) {
      if (sock.session?.docPath === oldRel) targets.add(sock);
    }
    for (const sock of targets) {
      if (!sock.session) continue;
      sock.session.docPath = file.rel;
      if (!sock.session.gone) send(sock, message);
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
      const found = await walkTree(repo.path, rel);
      if (!found || found.kind !== "file") return fail(socket, 404);
      bytes = await fs.readFile(found.real);
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
    // Leaving every path where it is does not notify the listeners.
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

    const assetPlans = [];
    for (const pair of pairs) {
      const srcDir = assetDirOf(pair.src);
      const destDir = assetDirOf(pair.dest);
      if (!srcDir || !destDir || srcDir === destDir) continue;
      const srcFull = path.join(docsDir, srcDir);
      const destAsset = path.join(docsDir, destDir);
      let info;
      try {
        info = await fs.lstat(srcFull);
      } catch (err) {
        if (err && err.code === "ENOENT") info = null;
        else throw err;
      }
      // The destination directory already belongs to another document. Leave both.
      if (fileMove && (await existsPath(destAsset))) return fail(socket, 409);
      if (!info || info.isSymbolicLink() || !info.isDirectory()) continue;
      const names = await listAssetNames(docsDir, srcDir);
      assetPlans.push({ srcDir, destDir, srcFull, destAsset, names });
    }

    const srcReal = await resolveInside(docsDir, rel);
    if (!srcReal) return fail(socket, 404);
    const destFull = await placedFull(docsDir, dir, baseName(rel));
    if (!destFull) return fail(socket, 404);
    if (await existsPath(destFull)) return fail(socket, 409);
    await fs.rename(srcReal, destFull);
    // A directory rename already carried the nested asset directories.
    if (fileMove) {
      for (const plan of assetPlans) await fs.rename(plan.srcFull, plan.destAsset);
    }

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
    for (const pair of pairs) {
      const fromDir = assetDirOf(pair.src);
      const toDir = assetDirOf(pair.dest);
      const cached = opened.find((item) => item.src === pair.src);
      const full = cached
        ? cached.file.full
        : (fileMove ? destFull : path.join(destFull, pair.src.slice(rel.length + 1)));
      let text = cached ? cached.file.text : null;
      if (text == null) {
        try {
          text = await fs.readFile(full, "utf8");
        } catch {
          continue;
        }
      }
      const next = rewriteImageDirs(text, fromDir, toDir);
      if (next === text) continue;
      if (cached) {
        cached.file.text = next;
        cached.file.rev += 1;
      }
      await writeAtomic(full, next);
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
    // The previous socket of this page can still be connected. Opening another
    // document drops it, or the pictures would stay until that socket noticed.
    await releaseOtherTokenDocs(socket, rel);
    send(socket, message);
  }

  async function releaseOtherTokenDocs(socket, rel) {
    const token = socket.session?.token;
    if (!token) return;
    for (const sock of [...sockets]) {
      if (sock === socket || sock.session?.token !== token) continue;
      if (!sock.session.docPath || sock.session.docPath === rel) continue;
      await releaseFile(sock);
    }
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
    const dest = await createDest(docsDir, rel);
    if (!dest) return fail(socket, 404);
    if (await existsPath(dest)) return fail(socket, 409);
    await writeAtomic(dest, text);
    files.set(rel, { rel, full: dest, rev: 0, text, subscribers: new Set(), locks: new Map() });
    broadcastDocs(repo, await docsPayload(repo));
    await onOpen(socket, { path: rel });
  }

  async function onTickets(socket) {
    const repo = socket.session.repo;
    if (!repo) return fail(socket, 400);
    send(socket, await ticketsPayload(repo));
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
    let assignee = "";
    if (Object.prototype.hasOwnProperty.call(msg, "assignee")) {
      const parsedAssignee = validAssignee(msg.assignee);
      if (parsedAssignee === null) return fail(socket, 400);
      assignee = parsedAssignee;
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
      assignee,
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
    await broadcastTickets();
    await onOpen(socket, { path: allocated.rel });
  }

  async function onTicketSet(socket, msg) {
    const sessionRepo = socket.session.repo;
    if (!sessionRepo) return fail(socket, 400);
    if (Object.prototype.hasOwnProperty.call(msg, "reporter") || Object.prototype.hasOwnProperty.call(msg, "created")) {
      return fail(socket, 400);
    }
    // The file is not in this session's repo. An unregistered name is not a file.
    let repo = sessionRepo;
    if (Object.prototype.hasOwnProperty.call(msg, "repo")) {
      if (typeof msg.repo !== "string") return fail(socket, 404);
      const named = repos.get(msg.repo);
      if (!named) return fail(socket, 404);
      repo = named;
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
    if (Object.prototype.hasOwnProperty.call(msg, "assignee")) {
      const parsedAssignee = validAssignee(msg.assignee);
      if (parsedAssignee === null) return fail(socket, 400);
      next.assignee = parsedAssignee;
    }
    if (Object.prototype.hasOwnProperty.call(msg, "parent")) next.parent = msg.parent;
    if (Object.prototype.hasOwnProperty.call(msg, "depends")) next.depends = msg.depends;
    const composed = composeTicket({ ...next, id: file.ticket.id, body: file.text });
    if (composed == null) return fail(socket, 400);
    const parsed = parseTicket(file.ticket.id, composed);
    if (!parsed) return fail(socket, 400);
    // A stored link whose ticket is gone is removed with this write. One this
    // set adds is still a conflict. Bare ids stay bare: home is the file's repo.
    const index = await linkIndex(repo);
    const dropped = dropStoredMissing(index, file.ticket.parent, file.ticket.depends, parsed.parent, parsed.depends);
    const reason = rejectLink(index, parsed.id, dropped.parent, dropped.depends);
    if (reason) return fail(socket, 409);
    const stored = { ...parsed, parent: dropped.parent, depends: dropped.depends };
    const rewritten = composeTicket({ ...stored, body: file.text });
    if (rewritten == null) return fail(socket, 400);
    const current = composeTicket({ ...file.ticket, body: file.text });
    if (rewritten === current) return;
    // Another socket in that repo has the file. Same refusal as delete.
    if (repo !== sessionRepo) {
      const holder = otherHolder(repo, rel, socket);
      if (holder) return fail(socket, 409, { heldBy: holder });
    }
    await writeAtomic(file.full, rewritten);
    file.rev += 1;
    file.ticket = ticketView(stored, file.rev);
    await broadcastTickets();
    broadcast(file, ticketNotice(file));
  }

  async function rewriteTicketLinks(repo, id, parent, depends) {
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

  // The requester may still have the file open. Removal is not an edit: no undo entry.
  async function unlinkFile(socket, rel) {
    const repo = socket.session.repo;
    if (socket.session.docPath === rel) await releaseFile(socket);
    const cached = repo.files.get(rel);
    repo.files.delete(rel);
    await fs.rm(cached ? cached.full : path.join(repo.path, rel), { force: true });
    await removeAssetDir(repo, rel);
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
    const gone = new Set([id]);
    for (const ticket of all) {
      if (ticket.id === id) continue;
      const parent = clearedParent(ticket.parent, gone, repo.name);
      const depends = clearedDepends(ticket.depends, gone, repo.name);
      if (parent === ticket.parent && depends.length === ticket.depends.length) continue;
      await rewriteTicketLinks(repo, ticket.id, parent, depends);
    }
    await broadcastTickets();
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
      await removeAssetDir(repo, rel);
    }
    for (const ticket of all) {
      if (closedIds.has(ticket.id)) continue;
      const parent = clearedParent(ticket.parent, closedIds, repo.name);
      const depends = clearedDepends(ticket.depends, closedIds, repo.name);
      if (parent === ticket.parent && depends.length === ticket.depends.length) continue;
      await rewriteTicketLinks(repo, ticket.id, parent, depends);
    }
    await broadcastTickets();
  }

  async function onLock(socket, msg) {
    const session = socket.session;
    const files = session.repo?.files;
    if (!files) return fail(socket, 400);
    const file = files.get(session.docPath);
    if (!file || msg.path !== file.rel) return fail(socket, 409);
    if (typeof msg.rev !== "number" || msg.rev !== file.rev) return fail(socket, 409);
    // The caret left the body. This page no longer holds the lines it had locked.
    if (msg.release === true) {
      session.lines = new Set();
      syncLocks(file);
      broadcast(file, { type: "locks", path: file.rel, rev: file.rev, lines: lockSnapshot(file) });
      return;
    }
    const anchor = clampOffset(msg.anchor, file.text.length);
    const cursor = clampOffset(msg.cursor, file.text.length);
    if (anchor == null || cursor == null) return fail(socket, 400);
    const nextLines = new Set(touchedLines(file.text, Math.min(anchor, cursor), Math.max(anchor, cursor)));
    for (const index of nextLines) {
      const owner = file.locks.get(index);
      if (owner && !sameSession(owner, socket)) return fail(socket, 409, { heldBy: owner.session.username });
    }
    // Opening this path leaves the previous socket subscribed. The same token takes its lines.
    for (const sock of file.subscribers) {
      if (sock === socket || !sameSession(sock, socket)) continue;
      for (const index of nextLines) sock.session.lines.delete(index);
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
        if (owner && !sameSession(owner, socket)) return owner.session.username;
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
    // group folds after publish. The caret this entry restores stays where the run began.
    // Do not rebase the entry this splice joins: undo inverts the new splice first.
    // An append still lengthens the one insert. Anything else stays its own splice.
    const prior = session.undo.length > 0 ? session.undo[session.undo.length - 1] : null;
    const foldOp = msg.op === "insert" || msg.op === "backspace" || msg.op === "delete";
    const appendFold = msg.group === true && msg.op === "insert" && canFoldTyping(prior, changes);
    const folding = msg.group === true && foldOp && canFoldGroup(prior, changes);
    const keptCursor = prior ? prior.cursor : 0;
    const keptAnchor = prior ? prior.anchor : 0;
    const wrote = await publish(
      socket,
      file,
      file.text,
      changes,
      { cursor: produced.cursor, anchor: produced.anchor },
      folding ? prior : entry,
      mode,
    );
    if (wrote !== true) {
      session.cursor = savedCursor;
      session.anchor = savedAnchor;
      return failHeld(socket, wrote);
    }
    session.redo = [];
    if (folding && prior && !prior.poison) {
      if (appendFold) prior.changes[0].inserted += changes[0].inserted;
      else prior.changes.push(...copyChanges(changes));
      prior.cursor = keptCursor;
      prior.anchor = keptAnchor;
      prior.cursorAfter = produced.cursor;
      prior.anchorAfter = produced.anchor;
    } else {
      pushCap(session.undo, entry);
    }
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

  // The closed socket is parked, not subscribed, so an edit while it is down still
  // shifts its caret. onSelect returns immediately when repo is already set.
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
      if (file.suspended) file.suspended.delete(from);
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
    // The live socket already owns this document. Sweeping here would delete
    // pictures that socket still has open.
    if (session.adopted) return;
    // A page token is gone as a subscriber and holds no block. The caret stays
    // parked so the next hello with this token can adopt it. No subscriber left
    // means the unreferenced pictures go, including a closed browser.
    if (session.token) {
      await suspendFile(socket);
      return;
    }
    await releaseFile(socket);
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

    const repo = { name: msg.name, description, path: real, files: new Map() };
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
    await releaseFile(socket);
    session.repo = repo;
    clearDocState(session);
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
    // The writer's caret stays in the prose. A fresh state would publish offset 0,
    // and this user's page would adopt that.
    const before = createState(file.text, socket.session.cursor, socket.session.anchor);
    const produced = replaceCommentBody(before, threadId, body);
    if (produced === before || !Array.isArray(produced.changes) || produced.changes.length === 0) {
      sendComment(socket, file, threadId, noteId);
      return;
    }
    const wrote = await publish(
      socket,
      file,
      file.text,
      produced.changes,
      { cursor: produced.cursor, anchor: produced.anchor },
      null,
      "comment",
    );
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
    // The deleter's caret stays in the prose. A fresh state would publish offset 0,
    // and this user's page would adopt that.
    const before = createState(file.text, socket.session.cursor, socket.session.anchor);
    const produced = removeCommentThread(before, msg.id);
    if (produced === before || !Array.isArray(produced.changes) || produced.changes.length === 0) return fail(socket, 404);
    const wrote = await publish(
      socket,
      file,
      file.text,
      produced.changes,
      { cursor: produced.cursor, anchor: produced.anchor },
      null,
      "comment",
    );
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

  async function onAttach(socket, msg, payload) {
    const session = socket.session;
    if (!session || session.gone || session.ending) return;
    const repo = session.repo;
    if (!repo || !session.username) return fail(socket, 400);
    if (!msg || typeof msg !== "object") return fail(socket, 400);
    const rel = safeRel(msg.path);
    const dir = rel ? assetDirOf(rel) : null;
    if (!rel || !dir || !isMarkdownPath(rel)) return fail(socket, 404);
    if (rel.startsWith("tickets/") && !ticketIdFromRel(rel)) return fail(socket, 404);
    const file = await loadFile(repo, rel);
    if (!file) return fail(socket, 404);
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
    if (bytes.length === 0) return fail(socket, 400, { reason: "empty image" });
    if (bytes.length > MAX_PAYLOAD) return fail(socket, 400, { reason: "image is too large" });
    const ext = imageKind(bytes);
    if (!ext) return fail(socket, 400, { reason: "not an image" });

    const ranged = msg.start !== undefined || msg.end !== undefined || Object.prototype.hasOwnProperty.call(msg, "expect");
    let point = null;
    let range = null;
    if (ranged) {
      const start = linePosition(msg.start);
      const end = linePosition(msg.end);
      if (!start || !end || typeof msg.expect !== "string") return fail(socket, 400);
      const from = offsetAt(file.text, start.line, start.offset);
      const to = offsetAt(file.text, end.line, end.offset);
      if (from.error || to.error) return fail(socket, 400);
      const lo = Math.min(from.offset, to.offset);
      const hi = Math.max(from.offset, to.offset);
      if (file.text.slice(lo, hi) !== msg.expect) return fail(socket, 409, { reason: "context" });
      range = { lo, hi };
      point = lo;
    } else if (Object.prototype.hasOwnProperty.call(msg, "cursor")) {
      if (!Number.isInteger(msg.cursor) || msg.cursor < 0 || msg.cursor > file.text.length) return fail(socket, 400);
      point = msg.cursor;
    } else {
      return fail(socket, 400);
    }

    const named = await claimImageFile(repo, dir, ext, file.text);
    if (!named) return fail(socket, 500);
    const line = imageLineFor(dir, named.file);
    const place = range ? imageRangePlacement(file.text, range.lo, range.hi, line) : imagePlacement(file.text, point, line);
    if (place.error) return fail(socket, place.error);
    const change = {
      from: place.from,
      to: place.to,
      inserted: place.inserted,
      removed: place.removed,
    };
    const held = holderAt(file, socket, point) || holderOf(file, socket, [change]);
    if (held) return fail(socket, 409, { heldBy: held });

    const dirReal = await prepareAssetDir(repo, dir);
    if (!dirReal) return fail(socket, 404);
    const imageFull = path.join(dirReal, named.file);
    if (await existsPath(imageFull)) return fail(socket, 500);
    await writeAtomic(imageFull, bytes);

    const prior = session.docPath === file.rel
      ? { cursor: session.cursor, anchor: session.anchor }
      : { cursor: 0, anchor: 0 };
    await ensureSubscribed(socket, file);
    const entry = {
      changes: copyChanges([change]),
      cursor: prior.cursor,
      anchor: prior.anchor,
      cursorAfter: place.caret,
      anchorAfter: place.caret,
      poison: false,
    };
    const wrote = await publish(
      socket,
      file,
      file.text,
      [change],
      { cursor: place.caret, anchor: place.caret },
      null,
      "edit",
    );
    if (wrote !== true) {
      await fs.rm(imageFull, { force: true });
      return wrote && wrote.heldBy ? failHeld(socket, wrote) : fail(socket, 500);
    }
    session.redo = [];
    pushCap(session.undo, entry);
    const reply = fileFrame(file);
    reply.cursor = place.caret;
    reply.anchor = place.caret;
    send(socket, reply);
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
    if (msg.type === "attach") return;
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
        let preview = null;
        try {
          preview = JSON.parse(payload.toString("utf8"));
        } catch {
          preview = null;
        }
        // The binary frame is the next message. Record it before the queue runs so a
        // picture is not mistaken for an unexpected binary frame.
        if (preview && preview.type === "attach") {
          session.expectImage = true;
          session.attach = preview;
        } else {
          session.expectImage = false;
          session.attach = null;
        }
        enqueue(() => handleText(socket, payload)).catch((err) => {
          console.error(err);
          fail(socket, 500);
        });
      },
      onBinary(payload) {
        if (!session.expectImage || !session.attach) {
          endSocket(socket, "binary");
          return;
        }
        const attached = session.attach;
        session.expectImage = false;
        session.attach = null;
        enqueue(() => onAttach(socket, attached, payload)).catch((err) => {
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
      // runs. Queue the disconnect on this queue before returning it.
      if (!stopped) {
        stopped = true;
        clearInterval(pingTimer);
        for (const sock of [...sockets]) {
          enqueue(() => disconnect(sock)).catch((err) => console.error(err));
          sock.destroy();
        }
      }
      return queue;
    },
  };
}
