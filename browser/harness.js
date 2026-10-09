import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "cli.js");
const CHROMIUM = process.env.VIEWMARK_CHROMIUM || "/usr/bin/chromium";
const LIVE_PORT = Number(process.env.VIEWMARK_PORT || 8765);
export const USER = "qa-bot";
export const OTHER = "qa-two";
export const AGENT = "qa-cli";
export const REPO = "qa";

const BOX_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40"><rect width="120" height="40" fill="#888"/></svg>\n';

export function cli(port, args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "--port", String(port), ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    child.stdin.end(input);
  });
}

// A throwaway hub in its own process, on a free port, over a temporary state directory, with
// one temporary repo. The cells' documents are created and read only through the CLI on that
// port; nothing here writes to the hub a person uses.
export async function startHub() {
  const state = mkdtempSync(path.join(tmpdir(), "viewmark-qa-state-"));
  const repo = mkdtempSync(path.join(tmpdir(), "viewmark-qa-repo-"));
  writeFileSync(path.join(repo, "box.svg"), BOX_SVG);
  const child = spawn(process.execPath, [CLI, "--port", "0", "serve", state], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const bound = /^127\.0\.0\.1:(\d+)\t/m.exec(out);
      if (bound) resolve(Number(bound[1]));
    });
    child.once("exit", (code) => reject(new Error(`serve exited with ${code}`)));
  });
  if (port === LIVE_PORT) throw new Error(`the test hub came up on ${LIVE_PORT}, the live hub's port`);
  const registered = await cli(port, ["--user", USER, "repo", "register", "--name", REPO, "--description", "qa", "--path", repo]);
  if (registered.code !== 0) throw new Error(`repo register: ${registered.stderr}`);
  return {
    port,
    async create(file, text) {
      const made = await cli(port, ["--user", USER, "--repo", REPO, "create", file], text);
      if (made.code !== 0) throw new Error(`create ${file}: ${made.stderr}`);
    },
    edit(file, diff, user = AGENT) {
      return cli(port, ["--user", user, "--repo", REPO, "edit", file], diff);
    },
    comment(file, start, end, expect, text, user = AGENT) {
      return cli(port, ["--user", user, "--repo", REPO, "comment", "add", file, "--start", start, "--end", end, "--expect", expect], text);
    },
    async show(file, user = USER) {
      const shown = await cli(port, ["--user", user, "--repo", REPO, "show", file]);
      if (shown.code !== 0) throw new Error(`show ${file}: ${shown.stderr}`);
      const rev = /rev (\d+)/.exec(shown.stderr);
      return { text: shown.stdout, rev: rev ? Number(rev[1]) : NaN };
    },
    async close() {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
      rmSync(state, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

// A TCP proxy in front of the test hub. The pages connect through it, so the harness can drop
// their sockets the way a network would.
export async function startProxy(target) {
  const open = new Set();
  let accepting = true;
  const server = net.createServer((client) => {
    if (!accepting) {
      client.destroy();
      return;
    }
    const upstream = net.connect(target, "127.0.0.1");
    for (const socket of [client, upstream]) {
      open.add(socket);
      socket.on("close", () => open.delete(socket));
      socket.on("error", () => {});
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  if (port === LIVE_PORT) throw new Error(`the proxy came up on ${LIVE_PORT}, the live hub's port`);
  return {
    port,
    drop() {
      for (const socket of open) socket.destroy();
    },
    // Drop every socket and refuse new ones until online().
    offline() {
      accepting = false;
      for (const socket of open) socket.destroy();
    },
    online() {
      accepting = true;
    },
    close() {
      for (const socket of open) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.next = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id != null && this.pending.has(message.id)) {
        const { resolve, reject, method } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
        return;
      }
      for (const fn of this.listeners.get(message.method) || []) fn(message.params);
    });
  }

  send(method, params = {}) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method).delete(fn);
  }
}

export async function launchBrowser() {
  const profile = mkdtempSync(path.join(tmpdir(), "viewmark-qa-profile-"));
  const args = [
    ...(process.env.VIEWMARK_HEADED === "1" ? [] : ["--headless=new"]),
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=1200,900",
    "--force-device-scale-factor=1",
    "--font-render-hinting=none",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--lang=en-US",
    "about:blank",
  ];
  const proc = spawn(CHROMIUM, args, { stdio: "ignore" });
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 200 && !existsSync(portFile); i += 1) await sleep(50);
  const devtools = readFileSync(portFile, "utf8").split("\n")[0];
  const targets = await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json();
  const target = targets.find((item) => item.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const base = `http://127.0.0.1:${devtools}`;
  const sockets = [ws];
  return {
    session: new Session(ws),
    targetId: target.id,
    async newSession() {
      const made = await (await fetch(`${base}/json/new?about:blank`, { method: "PUT" })).json();
      const other = new WebSocket(made.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        other.addEventListener("open", resolve, { once: true });
        other.addEventListener("error", reject, { once: true });
      });
      sockets.push(other);
      return { session: new Session(other), targetId: made.id };
    },
    async openBlank() {
      return (await (await fetch(`${base}/json/new?about:blank`, { method: "PUT" })).json()).id;
    },
    async activate(id) {
      await fetch(`${base}/json/activate/${id}`);
    },
    async closeTarget(id) {
      await fetch(`${base}/json/close/${id}`);
    },
    async close() {
      for (const socket of sockets) socket.close();
      proc.kill();
      await new Promise((resolve) => proc.once("exit", resolve));
      if (process.env.VIEWMARK_KEEP_PROFILE !== "1") rmSync(profile, { recursive: true, force: true });
    },
  };
}

// Passive: it records events and answers geometry questions. It never changes the page.
const PAGE_SCRIPT = String.raw`
window.__qa = { selectionChanges: 0, log: [] };
document.addEventListener("selectionchange", () => { window.__qa.selectionChanges += 1; }, true);
for (const type of ["keydown", "beforeinput"]) {
  document.addEventListener(type, (event) => {
    window.__qa.log.push({ type, key: event.key, inputType: event.inputType, at: performance.now() });
  }, true);
}
window.__qaRoot = () => document.getElementById("editor");
window.__qaTextAt = (offset) => {
  const root = window.__qaRoot();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const tagged = node.parentElement && node.parentElement.closest("[data-start]");
    if (!tagged || tagged.closest(".md-lock")) continue;
    const start = Number(tagged.dataset.start);
    const end = Number(tagged.dataset.end);
    if (end - start !== node.length) continue;
    if (offset >= start && offset < end) return { node, index: offset - start };
  }
  return null;
};
window.__qaGlyph = (offset) => {
  const hit = window.__qaTextAt(offset);
  if (!hit) return null;
  const range = document.createRange();
  range.setStart(hit.node, hit.index);
  range.setEnd(hit.node, hit.index + 1);
  const rect = range.getClientRects()[0] || range.getBoundingClientRect();
  return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
};
window.__qaEmptyLine = (offset) => {
  for (const line of window.__qaRoot().querySelectorAll(".md-line")) {
    if (Number(line.dataset.start) === offset && Number(line.dataset.end) === offset && line.textContent === "") {
      const rect = line.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }
  }
  return null;
};
// A line drawn empty inside a block (a fence body line, or a line of hidden hard-break
// spaces) has no glyph; the <br> that ends it sits on that line.
window.__qaBreak = (offset) => {
  for (const el of window.__qaRoot().querySelectorAll(".md-break")) {
    if (Number(el.dataset.start) !== offset) continue;
    const rect = (el.querySelector("br") || el).getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  }
  return null;
};
// Where a caret at this offset belongs on screen, by the plan's rule. At a soft wrap the same
// offset ends one visual line and starts the next, and the browser may draw it on either, so
// the end of the earlier line is offered as an alternative.
window.__qaBoundary = (offset) => {
  const main = window.__qaBoundaryMain(offset);
  const before = offset > 0 ? window.__qaGlyph(offset - 1) : null;
  const after = window.__qaGlyph(offset);
  if (main && before && after && Math.abs(after.top - before.top) >= 2) {
    main.alt = { x: window.__qaRtl(offset - 1) ? before.left : before.right, top: before.top, bottom: before.bottom };
  }
  return main;
};
window.__qaBoundaryMain = (offset) => {
  const before = offset > 0 ? window.__qaGlyph(offset - 1) : null;
  const after = window.__qaGlyph(offset);
  if (before && (!after || Math.abs(after.top - before.top) < 2)) return { x: window.__qaRtl(offset - 1) ? before.left : before.right, top: before.top, bottom: before.bottom };
  if (after) return { x: window.__qaRtl(offset) ? after.right : after.left, top: after.top, bottom: after.bottom };
  const empty = window.__qaEmptyLine(offset);
  if (empty) return { x: empty.left, top: empty.top, bottom: empty.bottom };
  if (before) return { x: before.right, top: before.top, bottom: before.bottom };
  const br = window.__qaBreak(offset);
  if (br) return { x: br.left, top: br.top, bottom: br.bottom };
  return null;
};
// 1 px inside the glyph after the boundary, or inside the glyph before it at a line end.
// A right-to-left glyph starts at its right edge.
window.__qaRtl = (offset) => {
  const hit = window.__qaTextAt(offset);
  return !!hit && /[\u0590-\u08ff]/.test(hit.node.data[hit.index]);
};
window.__qaClickPoint = (offset) => {
  const after = window.__qaGlyph(offset);
  if (after) return { x: window.__qaRtl(offset) ? after.right - 1 : after.left + 1, y: (after.top + after.bottom) / 2, how: "after" };
  const before = offset > 0 ? window.__qaGlyph(offset - 1) : null;
  if (before) return { x: window.__qaRtl(offset - 1) ? before.left + 1 : before.right - 1, y: (before.top + before.bottom) / 2, how: "before" };
  const empty = window.__qaEmptyLine(offset);
  if (empty) return { x: empty.left + 4, y: (empty.top + empty.bottom) / 2, how: "empty" };
  const br = window.__qaBreak(offset);
  if (br) return { x: br.left + 1, y: (br.top + br.bottom) / 2, how: "break" };
  return null;
};
window.__qaBelow = () => {
  const lines = window.__qaRoot().querySelectorAll(".md-line, .md-atom");
  let bottom = 0;
  let left = window.__qaRoot().getBoundingClientRect().left;
  for (const line of lines) {
    const rect = line.getBoundingClientRect();
    if (rect.bottom > bottom) { bottom = rect.bottom; left = rect.left; }
  }
  return { x: left + 20, y: bottom + 40 };
};
// The drawn text of the editor, flattened, with each piece's text node.
window.__qaDrawn = () => {
  const root = window.__qaRoot();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const pieces = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement && node.parentElement.closest(".md-lock")) continue;
    pieces.push({ node, at: text.length });
    text += node.data;
  }
  return { text, pieces };
};
window.__qaDrawnRect = (drawn, index) => {
  for (let i = drawn.pieces.length - 1; i >= 0; i -= 1) {
    const piece = drawn.pieces[i];
    if (index >= piece.at && index < piece.at + piece.node.length) {
      const range = document.createRange();
      range.setStart(piece.node, index - piece.at);
      range.setEnd(piece.node, index - piece.at + 1);
      return range.getClientRects()[0] || range.getBoundingClientRect();
    }
  }
  return null;
};
window.__qaFindText = (needle, nth) => {
  const drawn = window.__qaDrawn();
  let from = -1;
  for (let k = 0; k < nth; k += 1) {
    from = drawn.text.indexOf(needle, from + 1);
    if (from < 0) return null;
  }
  return { drawn, from };
};
// A press at the boundary marked with ¦ in drawn text.
window.__qaTextPoint = (marked, nth) => {
  const bar = marked.indexOf("¦");
  const plain = marked.replace("¦", "");
  const found = window.__qaFindText(plain, nth);
  if (!found) return null;
  const at = found.from + bar;
  if (bar < plain.length) {
    const r = window.__qaDrawnRect(found.drawn, at);
    return r && { x: r.left + 1, y: (r.top + r.bottom) / 2 };
  }
  const r = window.__qaDrawnRect(found.drawn, at - 1);
  return r && { x: r.right - 1, y: (r.top + r.bottom) / 2 };
};
// 1 px left of the centre of a glyph, the middle one of a word or the index-th of a run.
window.__qaWordPoint = (word, nth, index) => {
  const found = window.__qaFindText(word, nth);
  if (!found) return null;
  const at = found.from + (index == null ? Math.floor((word.length - 1) / 2) : index);
  const r = window.__qaDrawnRect(found.drawn, at);
  return r && { x: (r.left + r.right) / 2 - 1, y: (r.top + r.bottom) / 2 };
};
window.__qaTarget = (name, arg) => {
  const root = window.__qaRoot();
  const centre = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
  };
  if (name === "image") return centre(root.querySelector(".md-image"));
  if (name === "diagram") return centre(root.querySelector(".md-diagram"));
  if (name === "cell") return centre([...root.querySelectorAll("td, th")].find((cell) => cell.textContent.trim() === arg));
  if (name === "rule") {
    const rule = root.querySelector(".md-hr");
    if (!rule) return null;
    const r = rule.getBoundingClientRect();
    return { x: r.left + 20, y: r.top + r.height / 2 };
  }
  if (name === "table edge") {
    const box = root.querySelector(".md-table");
    if (!box) return null;
    const table = box.querySelector("table").getBoundingClientRect();
    const outer = box.getBoundingClientRect();
    return outer.right > table.right + 4 ? { x: table.right + 3, y: table.top + 3 } : { x: table.left + 1, y: table.top + 1 };
  }
  if (name === "bullet") {
    const line = root.querySelector(".md-li");
    if (!line) return null;
    const r = line.getBoundingClientRect();
    return { x: r.left - 8, y: r.top + Math.min(12, r.height / 2) };
  }
  if (name === "bar") {
    const line = root.querySelector(".md-quote");
    if (!line) return null;
    const r = line.getBoundingClientRect();
    return { x: r.left + 1, y: (r.top + r.bottom) / 2 };
  }
  if (name === "below") return window.__qaBelow();
  if (name === "joining space") {
    const drawn = window.__qaDrawn();
    for (const piece of drawn.pieces) {
      const tagged = piece.node.parentElement.closest("[data-start]");
      if (piece.node.data === " " && tagged && Number(tagged.dataset.end) - Number(tagged.dataset.start) === 1) {
        const range = document.createRange();
        range.selectNodeContents(piece.node);
        const r = range.getClientRects()[0];
        return arg === "left" ? { x: r.left + 1, y: (r.top + r.bottom) / 2 } : { x: r.right - 1, y: (r.top + r.bottom) / 2 };
      }
    }
    return null;
  }
  if (name === "empty line under") {
    const lines = [...root.querySelectorAll(".md-line")];
    const after = lines.findIndex((line) => line.textContent.includes(arg.word));
    // Another session's lock label is not text on the line.
    const text = (line) => [...line.childNodes].filter((node) => !(node.classList && node.classList.contains("md-lock"))).map((node) => node.textContent).join("");
    const empties = lines.slice(after + 1).filter((line) => text(line) === "" && !line.classList.contains("md-hr"));
    const line = empties[arg.nth - 1];
    if (!line) return null;
    const r = line.getBoundingClientRect();
    return { x: r.left + 4, y: (r.top + r.bottom) / 2 };
  }
  if (name === "tab") {
    const found = window.__qaFindText("\t", 1);
    const r = found && window.__qaDrawnRect(found.drawn, found.from);
    return r && { x: r.right - 1, y: (r.top + r.bottom) / 2 };
  }
  return null;
};
window.__qaPath = (node) => {
  const parts = [];
  for (let at = node; at && at !== window.__qaRoot(); at = at.parentNode) {
    if (at.nodeType === 9) return "outside the editor: " + parts.join(" > ");
    if (at.nodeType === 3) parts.unshift("#text");
    else if (!at.tagName) parts.unshift(at.nodeName);
    else parts.unshift(at.tagName.toLowerCase() + (at.className ? "." + String(at.className).trim().split(/\s+/).join(".") : "") + (at.dataset && at.dataset.start != null ? "[" + at.dataset.start + "-" + at.dataset.end + "]" : ""));
  }
  return parts.join(" > ");
};
window.__qaCaret = async () => {
  const editor = await import("/src/editor.js");
  const root = window.__qaRoot();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return { none: true };
  const inside = root.contains(sel.anchorNode) && root.contains(sel.focusNode);
  const range = sel.getRangeAt(0);
  let rect = null;
  let fallback = false;
  if (range.collapsed) {
    const rects = range.getClientRects();
    if (rects.length) rect = rects[0];
    else {
      const holder = sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement;
      rect = holder.getBoundingClientRect();
      fallback = true;
    }
  }
  return {
    inside,
    anchor: inside ? editor.mapOffset(sel.anchorNode, sel.anchorOffset) : null,
    focus: inside ? editor.mapOffset(sel.focusNode, sel.focusOffset) : null,
    anchorPath: window.__qaPath(sel.anchorNode) + ":" + sel.anchorOffset,
    focusPath: window.__qaPath(sel.focusNode) + ":" + sel.focusOffset,
    rect: rect ? { x: rect.left, top: rect.top, bottom: rect.bottom } : null,
    fallback,
    focused: document.hasFocus() && (document.activeElement === root || root.contains(document.activeElement)),
    raw: [...root.querySelectorAll(".md-raw")].map((el) => el.dataset.start == null ? "?" : el.dataset.start + "-" + el.dataset.end),
  };
};
`;

const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  "←": { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  "↑": { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  "→": { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  "↓": { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
};
const MODIFIERS = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };

export class Page {
  constructor(session, port) {
    this.session = session;
    this.port = port;
    this.frames = [];
    this.lastFrameAt = 0;
  }

  async init() {
    const { session } = this;
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Network.enable");
    await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await session.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_SCRIPT });
    const record = (dir) => (params) => {
      let data = null;
      try {
        data = JSON.parse(params.response.payloadData);
      } catch {
        data = null;
      }
      if (data && (data.type === "ping" || data.type === "pong")) return;
      this.frames.push({ dir, at: Date.now(), data });
      this.lastFrameAt = Date.now();
    };
    session.on("Network.webSocketFrameReceived", record("in"));
    session.on("Network.webSocketFrameSent", record("out"));
    session.on("Runtime.exceptionThrown", (params) => this.frames.push({ dir: "exception", at: Date.now(), data: params.exceptionDetails.text }));
  }

  async eval(expression) {
    const result = await this.session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`eval ${expression}: ${result.exceptionDetails.text} ${JSON.stringify(result.exceptionDetails.exception?.description || "")}`);
    return result.result.value;
  }

  async login(user = USER) {
    this.user = user;
    await this.session.send("Page.navigate", { url: `http://127.0.0.1:${this.port}/` });
    await this.until(() => this.eval("!!document.querySelector('.md-login-name') && document.readyState === 'complete'"), "login field");
    await this.eval("document.querySelector('.md-login-name').focus(); true");
    await this.type(user);
    await this.key("Enter");
    await this.until(() => this.frames.some((frame) => frame.dir === "in" && frame.data && frame.data.type === "hello"), "hello");
    await this.quiet();
  }

  // A full page load per file, so a page wedged by one cell cannot fail the next.
  async open(file) {
    const since = this.frames.length;
    this.loads = (this.loads || 0) + 1;
    await this.session.send("Page.navigate", { url: `http://127.0.0.1:${this.port}/?load=${this.loads}#${REPO}/doc/${encodeURIComponent(file)}` });
    await this.until(() => this.frames.slice(since).some((frame) => frame.dir === "in" && frame.data && frame.data.type === "file" && (frame.data.path == null || frame.data.path === file)), `file ${file}`);
    await this.eval("document.fonts.ready.then(() => Promise.all([...document.images].map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })))).then(() => true)");
    await this.quiet();
  }

  async until(check, what, timeout = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await check()) return;
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  async frame() {
    await this.eval("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
  }

  // Edits this page sent that the hub has not answered yet, by its own doc or by an error.
  unanswered() {
    let count = 0;
    for (const frame of this.frames) {
      const data = frame.data;
      if (!data) continue;
      if (frame.dir === "out" && (data.type === "edit" || data.type === "undo" || data.type === "redo")) count += 1;
      else if (frame.dir === "in" && ((data.type === "doc" && data.actor === this.user) || data.type === "error")) count = Math.max(0, count - 1);
    }
    return count;
  }

  // Every edit answered (for at most 2 s, so a page that never hears back still finishes the
  // cell), then two frames, then 100 ms with no socket frame, then no selectionchange in the
  // next frame.
  async quiet(timeout = 5000) {
    const started = Date.now();
    while (this.unanswered() > 0 && Date.now() - started < 2000) await sleep(10);
    while (Date.now() - started < timeout) {
      await this.frame();
      while (Date.now() - this.lastFrameAt < 100) await sleep(10);
      const before = await this.eval("window.__qa.selectionChanges");
      await this.frame();
      const after = await this.eval("window.__qa.selectionChanges");
      if (before === after && Date.now() - this.lastFrameAt >= 100) return;
    }
    throw new Error("no quiet");
  }

  async key(name, modifiers = []) {
    const bits = modifiers.reduce((sum, mod) => sum | MODIFIERS[mod], 0);
    // A chord reports the letter as the keyboard does: lower case unless Shift is held.
    const letter = /^[a-z]$/i.test(name) && bits & (MODIFIERS.Ctrl | MODIFIERS.Alt | MODIFIERS.Meta) ? (bits & MODIFIERS.Shift ? name.toUpperCase() : name.toLowerCase()) : name;
    // Only letters, digits, and space have a key code of their own; punctuation gets 0, so a
    // code like 35 for "#" is not read as End.
    const code = /[a-z]/i.test(name) ? `Key${name.toUpperCase()}` : /[0-9]/.test(name) ? `Digit${name}` : name === " " ? "Space" : "";
    const vk = /[a-z0-9 ]/i.test(name) ? name.toUpperCase().charCodeAt(0) : 0;
    const spec = KEYS[name] || (name.length === 1 ? { key: letter, code, windowsVirtualKeyCode: vk, text: letter } : null);
    if (!spec) throw new Error(`unknown key ${name}`);
    const text = bits & (MODIFIERS.Ctrl | MODIFIERS.Alt | MODIFIERS.Meta) ? undefined : spec.text;
    const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode, modifiers: bits };
    await this.session.send("Input.dispatchKeyEvent", { ...base, type: text ? "keyDown" : "rawKeyDown", text, unmodifiedText: text });
    await this.session.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }

  async type(text) {
    for (const ch of text) {
      if (/^[\x20-\x7e]$/.test(ch)) await this.key(ch);
      else await this.session.send("Input.insertText", { text: ch });
    }
  }

  async click(x, y, { clickCount = 1, button = "left", modifiers = 0, interval = 30 } = {}) {
    await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
    for (let count = 1; count <= clickCount; count += 1) {
      if (count > 1) await sleep(interval);
      await this.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: count, modifiers, buttons: button === "left" ? 1 : 4 });
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: count, modifiers, buttons: 0 });
    }
  }

  async drag(from, to) {
    await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
    await this.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1, buttons: 1 });
    for (let step = 1; step <= 10; step += 1) {
      const x = from.x + ((to.x - from.x) * step) / 10;
      const y = from.y + ((to.y - from.y) * step) / 10;
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    }
    await this.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1, buttons: 0 });
  }

  async clickOffset(offset) {
    const point = await this.eval(`window.__qaClickPoint(${offset})`);
    if (!point) return false;
    await this.click(point.x, point.y);
    return true;
  }

  async clickBelow() {
    const point = await this.eval("window.__qaBelow()");
    await this.click(point.x, point.y);
  }

  caret() {
    return this.eval("window.__qaCaret()");
  }

  boundary(offset) {
    return this.eval(`window.__qaBoundary(${offset})`);
  }
}
