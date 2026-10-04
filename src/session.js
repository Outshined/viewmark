// The editor paints a mirror. This module is the only place that runs doc.js
// for a local user, and the only place that owns the browser socket.

import {
  createState,
  addComment,
  insert,
  backspace,
  deleteForward,
  undo,
  redo,
  replaceCommentBody,
  removeCommentThread,
  setCommentResolved,
  replaceDocument,
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

  return {
    username: "",
    memory: true,
    send(message) {
      if (!message || message.type === "lock" || message.type === "open" || message.type === "hello" || message.type === "pong") {
        return;
      }
      if (message.type === "undo" || message.type === "redo") {
        const before = state.doc.length;
        const next = message.type === "undo" ? undo(state) : redo(state);
        if (next === state) return;
        state = next;
        deliver(0, before, state.doc, message.username);
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
        next = insert(base, inserted);
      } else if (message.op === "backspace") {
        next = backspace(base);
      } else if (message.op === "delete") {
        next = deleteForward(base);
      } else if (message.op === "comment.add") {
        const added = addComment(base.doc, base.anchor, base.cursor);
        if (!added) return;
        next = replaceDocument(base, added.doc, added.cursor);
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
      if (next === base) return;
      const oldLength = base.doc.length;
      state = next;
      if (message.op === "insert" || message.op === "backspace" || message.op === "delete") {
        deliver(from, to, inserted, message.username);
      } else {
        deliver(0, oldLength, state.doc, message.username);
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export function createSocketTransport({ username, socketFactory, location } = {}) {
  const url = socketURL(location);
  const factory = socketFactory || ((address) => new WebSocket(address));
  const socket = factory(url);
  const listeners = new Set();
  let buffer = [];
  let socketOpen = false;
  let closed = false;
  const name = typeof username === "string" ? username : "";
  // Queued before open so the wire order is hello, then list, then anything else.
  const outbound = [JSON.stringify({ type: "list", username: name })];

  function transmit(message) {
    if (closed) return;
    const data = JSON.stringify({ ...message, username: name });
    if (socketOpen) socket.send(data);
    else outbound.push(data);
  }

  function deliver(message) {
    if (listeners.size === 0) {
      buffer.push(message);
      return;
    }
    for (const fn of [...listeners]) fn(message);
  }

  function onOpen() {
    // A username keystroke can close this socket before the handshake finishes.
    if (closed) return;
    socketOpen = true;
    // Hello is the first frame. Anything queued while connecting follows it.
    socket.send(JSON.stringify({ type: "hello", username: name }));
    for (const data of outbound) socket.send(data);
    outbound.length = 0;
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

  if (socket && typeof socket.addEventListener === "function") {
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
  }

  return {
    username: name,
    memory: false,
    url,
    send(message) {
      if (!message || message.type === "hello") return;
      transmit(message);
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
      listeners.clear();
      buffer = [];
      outbound.length = 0;
      if (socket && typeof socket.removeEventListener === "function") {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("message", onMessage);
      }
      if (socket && typeof socket.close === "function") socket.close();
    },
  };
}
