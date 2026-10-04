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
import { acceptKey, createParser, encodeFrame, encodeText } from "./ws.js";

const PING_MS = 15000;
const IDLE_MS = 30000;
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
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await listMarkdown(path.join(dir, entry.name), rel));
    else if (entry.isFile() && (rel.endsWith(".md") || rel.endsWith(".markdown"))) out.push(rel);
  }
  out.sort();
  return out;
}

function closeCode(reason) {
  if (reason === "binary") return 1003;
  if (reason === "size") return 1009;
  if (reason === "empty") return 1008;
  return 1002;
}

export function createHub(docsDir) {
  const files = new Map();
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

  function touch(socket) {
    const session = socket.session;
    if (!session || session.gone) return;
    if (session.idle) clearTimeout(session.idle);
    session.idle = setTimeout(() => {
      enqueue(() => commitIfDirty(socket));
    }, IDLE_MS);
    session.idle.unref();
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

  async function commitIfDirty(socket) {
    const session = socket.session;
    if (!session || !session.dirtyPath || session.committing) return;
    const rel = session.dirtyPath;
    const username = session.username;
    session.committing = true;
    try {
      const top = (await git(docsDir, ["rev-parse", "--show-toplevel"])).trim();
      const topReal = await fs.realpath(top);
      if (topReal !== docsDir) throw new Error("refusing to commit outside the docs repo");
      const email = `${username}@viewmark.local`;
      const config = [
        "-c", `user.name=${username}`,
        "-c", `user.email=${email}`,
        "-c", "commit.gpgsign=false",
        "-c", "core.autocrlf=false",
      ];
      await git(docsDir, [...config, "add", "--", rel], username);
      try {
        await git(
          docsDir,
          [...config, "commit", "--author", `${username} <${email}>`, "-m", `Edit ${rel}`, "--", rel],
          username,
        );
      } catch (err) {
        const detail = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
        if (!/nothing to commit|nothing added/i.test(detail)) throw err;
      }
      if (session.dirtyPath === rel) session.dirtyPath = null;
    } finally {
      session.committing = false;
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
    await writeAtomic(file.full, after);
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
    socket.session.dirtyPath = file.rel;
    // The preparatory lock covers the splice, including a fence through EOF.
    // Keep the caret line so the rest can be taken. Do not commit for that.
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
    if (session.dirtyPath === rel) await commitIfDirty(socket);
  }

  async function loadFile(rel) {
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
    const file = { rel, full: real, rev: 0, text, subscribers: new Set(), locks: new Map() };
    files.set(rel, file);
    return file;
  }

  async function onList(socket) {
    const listed = await listMarkdown(docsDir, "");
    send(socket, { type: "docs", files: listed });
  }

  async function onOpen(socket, msg) {
    const rel = safeRel(msg.path);
    if (!rel) return fail(socket, 404);
    const file = await loadFile(rel);
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
    send(socket, {
      type: "file",
      path: file.rel,
      rev: file.rev,
      text: file.text,
      locks: lockSnapshot(file),
    });
  }

  async function onCreate(socket, msg) {
    const rel = safeRel(msg.path);
    if (!rel) return fail(socket, 404);
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
    const listed = await listMarkdown(docsDir, "");
    const docs = { type: "docs", files: listed };
    for (const sock of sockets) send(sock, docs);
    await onOpen(socket, { path: rel });
  }

  async function onLock(socket, msg) {
    touch(socket);
    const session = socket.session;
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
    const previous = session.lines;
    const releasedLast = previous.size > 0 && [...previous].every((index) => !nextLines.has(index));
    session.lines = nextLines;
    session.anchor = anchor;
    session.cursor = cursor;
    syncLocks(file);
    if (releasedLast && session.dirtyPath === file.rel) await commitIfDirty(socket);
    broadcast(file, { type: "locks", path: file.rel, rev: file.rev, lines: lockSnapshot(file) });
  }

  async function onEdit(socket, msg) {
    touch(socket);
    const session = socket.session;
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
    if (session.idle) clearTimeout(session.idle);
    session.idle = null;
    await releaseFile(socket);
    session.undo = [];
    session.redo = [];
    session.lines = new Set();
    if (session.dirtyPath) await commitIfDirty(socket);
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
      touch(socket);
      return;
    }
    if (msg.type === "pong") {
      if (msg.username !== undefined && msg.username !== session.username) return fail(socket, 403);
      touch(socket);
      return;
    }
    if (msg.username !== session.username) return fail(socket, 403);
    if (msg.type === "list") return onList(socket);
    if (msg.type === "open") return onOpen(socket, msg);
    if (msg.type === "create") return onCreate(socket, msg);
    if (msg.type === "lock") return onLock(socket, msg);
    if (msg.type === "edit") return onEdit(socket, msg);
    if (msg.type === "undo") return onHistory(socket, msg, "undo");
    if (msg.type === "redo") return onHistory(socket, msg, "redo");
    fail(socket, 400);
  }

  function attach(socket) {
    const session = {
      username: null,
      docPath: null,
      anchor: 0,
      cursor: 0,
      lines: new Set(),
      undo: [],
      redo: [],
      dirtyPath: null,
      idle: null,
      gone: false,
      ending: false,
      committing: false,
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
    docsDir,
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
      // enqueues its commit. Disconnect here so that commit is on this queue.
      if (!stopped) {
        stopped = true;
        clearInterval(pingTimer);
        for (const sock of [...sockets]) {
          if (sock.session?.idle) {
            clearTimeout(sock.session.idle);
            sock.session.idle = null;
          }
          enqueue(() => disconnect(sock)).catch((err) => console.error(err));
          sock.destroy();
        }
      }
      return queue;
    },
  };
}
