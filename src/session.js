// The editor paints a mirror. This module is the only place that runs doc.js
// for a local user, and the only place that owns the browser socket.

import {
  createState,
  addComment,
  addPinComment,
  insert,
  insertLiteral,
  moveText,
  backspace,
  deleteForward,
  undo,
  redo,
  replaceCommentBody,
  removeCommentThread,
  setCommentResolved,
  replaceDocument,
  commentThreads,
  appendCommentReply,
  reviseCommentNote,
} from "./doc.js";

function socketURL(location) {
  const loc = location || globalThis.location || { protocol: "http:", host: "localhost" };
  const protocol = loc.protocol === "https:" ? "wss:" : "ws:";
  const host = loc.host || "localhost";
  return `${protocol}//${host}/api/ws`;
}

// Undo length is part of the mirror the DOM tests read, so each doc message
// carries the snapshot stacks from the doc.js operation that just ran.
export function createMemoryTransport(doc, cursor = 0) {
  let state = createState(typeof doc === "string" ? doc : "", cursor);
  let rev = 0;
  const listeners = new Set();

  function deliverNoop(message) {
    const note = {
      type: "noop",
      path: typeof message.path === "string" ? message.path : "",
      rev,
    };
    for (const fn of listeners) fn(note);
  }

  function deliver(from, to, inserted, actor) {
    rev += 1;
    const message = {
      type: "doc",
      rev,
      text: state.doc,
      from,
      to,
      inserted,
      actor: typeof actor === "string" ? actor : "",
      cursor: state.cursor,
      anchor: state.anchor,
      undo: state.undo,
      redo: state.redo,
    };
    for (const fn of listeners) fn(message);
  }

  function selection(message) {
    const cursor = Number.isFinite(message.cursor) ? message.cursor : state.cursor;
    const anchor = Number.isFinite(message.anchor) ? message.anchor : cursor;
    return { ...state, cursor, anchor };
  }

  function commentAuthor(message) {
    if (typeof message.username === "string") return message.username;
    return typeof transport.username === "string" ? transport.username : "";
  }

  function writeComment(message) {
    if (typeof message.text !== "string" || typeof message.id !== "string") return;
    const thread = commentThreads(state.doc).find((item) => item.id === message.id);
    if (!thread) return;
    const author = commentAuthor(message);
    let result;
    if (message.type === "comment.reply") {
      result = appendCommentReply(thread.body, message.text, author, new Date().toISOString());
    } else {
      if (typeof message.note !== "number" || !Number.isInteger(message.note) || message.note < 0) return;
      result = reviseCommentNote(thread.body, message.note, message.text, author);
    }
    // A 403 still carries the previous body. Publishing it would look like a write.
    if (!result || result.error || result.unchanged) return;
    const base = selection(message);
    const next = replaceCommentBody(base, message.id, result.body);
    if (next === base) return;
    const oldLength = base.doc.length;
    state = next;
    deliver(0, oldLength, state.doc, author);
  }

  const transport = {
    username: "",
    memory: true,
    send(message) {
      if (!message || message.type === "lock" || message.type === "open" || message.type === "hello" || message.type === "pong") {
        return;
      }
      if (message.type === "undo" || message.type === "redo") {
        const before = state.doc.length;
        const next = message.type === "undo" ? undo(state) : redo(state);
        if (next === state) {
          deliverNoop(message);
          return;
        }
        state = next;
        deliver(0, before, state.doc, message.username);
        return;
      }
      if (message.type === "comment.reply" || message.type === "comment.edit") {
        writeComment(message);
        return;
      }
      if (message.type !== "edit") return;
      const base = selection(message);
      const from = Math.min(base.anchor, base.cursor);
      const to = Math.max(base.anchor, base.cursor);
      let next = base;
      let inserted = "";
      if (message.op === "insert") {
        inserted = typeof message.text === "string" ? message.text : "";
        next = insert(base, inserted, message.paste === true, message.raw === true);
        if (next && next.refused) return;
        if (next == null && message.raw === true) next = insertLiteral(base, inserted);
        if (next && next.refused) return;
        if (next && next !== base && Array.isArray(next.changes) && next.changes.length === 1
          && typeof message.caret === "number" && Number.isFinite(message.caret)) {
          const caret = Math.max(0, Math.min(next.doc.length, Math.trunc(message.caret)));
          next = { ...next, cursor: caret, anchor: caret };
        }
      } else if (message.op === "backspace") {
        next = backspace(base);
      } else if (message.op === "delete") {
        next = deleteForward(base);
      } else if (message.op === "move") {
        next = moveText(base, message.dest);
        if (next == null || next.refused) return;
      } else if (message.op === "comment.add") {
        const added = addComment(base.doc, base.anchor, base.cursor);
        if (!added) return;
        next = replaceDocument(base, added.doc, added.cursor);
        if (Number.isInteger(added.anchor)) next = { ...next, anchor: added.anchor };
        inserted = next.doc;
      } else if (message.op === "comment.pin") {
        const added = addPinComment(base.doc, message.offset, message.x, message.y);
        if (!added || added.refused) return;
        next = replaceDocument(base, added.doc, added.cursor);
        if (Number.isInteger(added.anchor)) next = { ...next, anchor: added.anchor };
        inserted = next.doc;
      } else if (message.op === "comment.save") {
        next = replaceCommentBody(base, message.id, typeof message.body === "string" ? message.body : "");
        inserted = next === base ? "" : next.doc;
      } else if (message.op === "comment.delete") {
        next = removeCommentThread(base, message.id);
        inserted = next === base ? "" : next.doc;
      } else if (message.op === "comment.resolve") {
        next = setCommentResolved(base, message.id, message.resolved === true);
        inserted = next === base ? "" : next.doc;
      } else {
        return;
      }
      if (next && next.refused) return;
      if (next === base) {
        deliverNoop(message);
        return;
      }
      // The op already pushed a snapshot. group drops it, so one undo returns to the
      // bytes before the run. A backspace or a break counts, not only an appending insert.
      const groupedOp = message.op === "insert" || message.op === "backspace" || message.op === "delete";
      if (message.group === true && groupedOp && base.undo.length > 0) {
        next = { ...next, undo: base.undo, redo: [] };
      }
      const oldLength = base.doc.length;
      state = next;
      if (message.op === "insert" || message.op === "backspace" || message.op === "delete" || message.op === "move") {
        deliver(from, to, inserted, message.username);
      } else {
        deliver(0, oldLength, state.doc, message.username);
      }
    },
    sendBinary() {},
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return transport;
}

function clamp(value, lo, hi) {
  const number = Number(value);
  if (number < lo) return lo;
  if (number > hi) return hi;
  return number;
}

export function retryDelay(attempt, roll) {
  const factor = 0.5 + 0.5 * clamp(roll, 0, 1);
  return Math.round(Math.min(30000, 500 * 2 ** attempt) * factor);
}

export function createSocketTransport({ username, socketFactory, location, random, schedule, session } = {}) {
  const url = socketURL(location);
  const factory = socketFactory || ((address) => new WebSocket(address));
  const roll = typeof random === "function" ? random : Math.random;
  const later = typeof schedule === "function" ? schedule : setTimeout;
  const defaultTimer = later === setTimeout;
  const listeners = new Set();
  let buffer = [];
  let socket = null;
  let socketOpen = false;
  let closed = false;
  let attempt = 0;
  let openedThisSocket = false;
  let sawOpen = false;
  let timer = null;
  const name = typeof username === "string" ? username : "";
  const sessionToken = typeof session === "string" ? session : "";

  function transmit(message) {
    // The editor holds a key this socket cannot take. A frame queued here would
    // still carry the rev from before the file that follows the reconnect.
    if (closed || !socketOpen || !socket || typeof socket.send !== "function") return false;
    try {
      socket.send(JSON.stringify({ ...message, username: name }));
    } catch {
      // A socket that has just closed throws. False means the editor still has the key.
      return false;
    }
    return true;
  }

  function transmitBinary(bytes) {
    if (closed || !socketOpen || !socket || typeof socket.send !== "function") return;
    const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    socket.send(payload);
  }

  function deliver(message) {
    if (listeners.size === 0) {
      buffer.push(message);
      return;
    }
    for (const fn of [...listeners]) fn(message);
  }

  function detach() {
    if (!socket || typeof socket.removeEventListener !== "function") return;
    socket.removeEventListener("open", onOpen);
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", onClose);
  }

  function bind(next) {
    detach();
    socket = next;
    socketOpen = false;
    openedThisSocket = false;
    if (socket && typeof socket.addEventListener === "function") {
      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose);
    }
  }

  function cancelTimer() {
    const pending = timer;
    timer = null;
    if (!pending) return;
    pending.alive = false;
    if (defaultTimer && pending.handle != null) clearTimeout(pending.handle);
  }

  function onOpen() {
    // close() can run before the handshake finishes.
    if (closed) return;
    const hello = { type: "hello", username: name };
    if (sessionToken) hello.session = sessionToken;
    socket.send(JSON.stringify(hello));
    socket.send(JSON.stringify({ type: "repos", username: name }));
    socketOpen = true;
    attempt = 0;
    openedThisSocket = true;
    const again = sawOpen;
    sawOpen = true;
    if (again) deliver({ type: "reconnect" });
  }

  function onMessage(event) {
    if (closed) return;
    let message;
    try {
      message = JSON.parse(event && event.data);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.type === "ping") {
      transmit({ type: "pong" });
      return;
    }
    deliver(message);
  }

  function onClose() {
    if (closed) return;
    detach();
    socketOpen = false;
    if (timer) return;
    const failed = !openedThisSocket;
    openedThisSocket = false;
    const delay = retryDelay(attempt, roll());
    if (failed) attempt += 1;
    const pending = { alive: true, handle: null };
    timer = pending;
    pending.handle = later(() => {
      if (timer === pending) timer = null;
      if (closed || pending.alive === false) return;
      bind(factory(url));
    }, delay);
    if (pending.handle && typeof pending.handle.unref === "function") pending.handle.unref();
  }

  bind(factory(url));

  return {
    username: name,
    token: sessionToken,
    memory: false,
    url,
    ready() {
      return socketOpen && !closed;
    },
    send(message) {
      if (!message || message.type === "hello") return false;
      return transmit(message);
    },
    sendBinary(bytes) {
      transmitBinary(bytes);
    },
    subscribe(fn) {
      listeners.add(fn);
      const queued = buffer;
      buffer = [];
      for (const message of queued) fn(message);
      return () => listeners.delete(fn);
    },
    close() {
      closed = true;
      socketOpen = false;
      cancelTimer();
      listeners.clear();
      buffer = [];
      detach();
      if (socket && typeof socket.close === "function") socket.close();
    },
  };
}
