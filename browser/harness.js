import { spawn } from "node:child_process";
import net from "node:net";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "cli.js");
const CHROMIUM = process.env.VIEWMARK_CHROMIUM || "/usr/bin/chromium";
// The browser the tests drive: chromium, or firefox (browser/firefox.js).
export const BROWSER = process.env.VIEWMARK_BROWSER === "firefox" ? "firefox" : "chromium";
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

// A child that cannot outlive this process. It runs under a shell in a process group of its
// own. The shell reads a pipe from this process, and when the pipe closes it ends the whole
// group: the child and everything it started, such as Chromium's renderers and crash
// handlers. The pipe closes when stopProcess ends it or when this process ends in any way,
// SIGKILL included. Then it removes the child's temporary directories, the ones named in
// TIE_RM, and only those under this harness's viewmark-qa- prefix. The child's own stdin is
// /dev/null, as for any background job in sh.
const TIE = '"$@" & read _; trap "" TERM; kill -TERM 0; wait; for d in $TIE_RM; do case "$d" in */viewmark-qa-*) rm -rf "$d" ;; esac; done';

export function spawnTied(command, args, stdout, stderr, cleanup = [], env = {}) {
  return spawn("/bin/sh", ["-c", TIE, "sh", command, ...args], { detached: true, stdio: ["pipe", stdout, stderr], env: { ...process.env, ...env, TIE_RM: cleanup.join(" ") } });
}

// Whether a command is on PATH, or is a path to an executable file.
export function onPath(command) {
  const dirs = command.includes("/") ? [""] : (process.env.PATH || "").split(":");
  return dirs.some((dir) => {
    try {
      accessSync(path.join(dir, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// What the browser under test can do. Firefox is driven over WebDriver BiDi, which has no
// drag-and-drop interception, no input method composition, and no platform font report, and
// its screenshots leave out the caret, so where the caret is painted cannot be read ("paint").
export function supports(feature) {
  if (BROWSER === "chromium") return true;
  return !["drag", "ime", "fonts", "paint"].includes(feature);
}

// Close the pipe and wait for the group to end; kill the group after 5 s if it has not.
export async function stopProcess(proc) {
  if (proc.exitCode != null || proc.signalCode != null) return;
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  proc.stdin.end();
  const timer = setTimeout(() => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
  }, 5000);
  await exited;
  clearTimeout(timer);
}

// A throwaway hub in its own process, on a free port, over a temporary state directory, with
// one temporary repo. The cells' documents are created and read only through the CLI on that
// port; nothing here writes to the hub a person uses.
export async function startHub() {
  const state = mkdtempSync(path.join(tmpdir(), "viewmark-qa-state-"));
  const repo = mkdtempSync(path.join(tmpdir(), "viewmark-qa-repo-"));
  writeFileSync(path.join(repo, "box.svg"), BOX_SVG);
  const child = spawnTied(process.execPath, [CLI, "--port", "0", "serve", state], "pipe", "inherit", [state, repo]);
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
      await stopProcess(child);
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
  if (BROWSER === "firefox") return (await import("./firefox.js")).launchFirefox();
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
  const proc = spawnTied(CHROMIUM, args, "ignore", "ignore", process.env.VIEWMARK_KEEP_PROFILE === "1" ? [] : [profile]);
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
    name: "chromium",
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
      await stopProcess(proc);
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
// A lock label that flashes (D26): a class besides md-lock, or an animation, CSS or scripted.
window.__qa.flashes = [];
const qaFlash = (label) => {
  const block = label.closest(".md-line, .md-atom");
  window.__qa.flashes.push({ name: label.textContent, block: block ? block.textContent : "", at: performance.now() });
};
new MutationObserver(() => {
  for (const label of document.querySelectorAll(".md-lock")) {
    if (label.className !== "md-lock" || label.getAnimations().length > 0) qaFlash(label);
  }
}).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });
document.addEventListener("animationstart", (event) => {
  const label = event.target.closest && event.target.closest(".md-lock");
  if (label) qaFlash(label);
}, true);
const qaAnimate = Element.prototype.animate;
Element.prototype.animate = function (...args) {
  const label = this.closest(".md-lock");
  if (label) qaFlash(label);
  return qaAnimate.apply(this, args);
};
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
  } else if (main && before) {
    // A raw list marker hangs in the gutter, so the text starts a gap to the right of it.
    // The caret at the marker's end belongs at the start of the text, where a typed letter goes.
    const start = window.__qaTextStart(offset - 1);
    if (start != null && before.right < start - 1 && (!after || after.left >= start - 1)) {
      main.alt = { x: before.right, top: before.top, bottom: before.bottom };
      main.x = start;
    }
  }
  return main;
};
// The left of a raw list line's text, inside its padding, or null for any other line.
window.__qaTextStart = (offset) => {
  const hit = window.__qaTextAt(offset);
  const line = hit && hit.node.parentElement.closest(".md-line.md-raw");
  if (!line || !line.matches(".md-li, .md-ol")) return null;
  const style = getComputedStyle(line);
  return line.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
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
  // A comment marker drawn as a handle has no glyph (R105). A caret just before or after it is
  // at the marker's edge, at the height of the text it marks.
  for (const marker of window.__qaRoot().querySelectorAll(".md-comment-marker")) {
    const from = Number(marker.dataset.start);
    const to = Number(marker.dataset.end);
    if (from !== offset && to !== offset) continue;
    const r = marker.getBoundingClientRect();
    const near = window.__qaGlyph(to) || (from > 0 ? window.__qaGlyph(from - 1) : null);
    return { x: from === offset ? r.left : r.right, top: near ? near.top : r.top, bottom: near ? near.bottom : r.bottom };
  }
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
  let emptyLine = false;
  let between = null;
  if (range.collapsed) {
    const rects = range.getClientRects();
    if (rects.length) rect = rects[0];
    else {
      const holder = sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement;
      rect = holder.getBoundingClientRect();
      fallback = true;
      // An empty line has no glyph; the caret is drawn in the line's own box.
      const line = holder.closest(".md-line");
      emptyLine = !!line && line.textContent === "";
      // The selection can sit on a container, between line elements. The browser paints the
      // caret at the start of the line after that point, and the harness finds it by its paint.
      if (!line && sel.focusNode.nodeType === 1) {
        const next = sel.focusNode.childNodes[sel.focusOffset];
        const lineEl = next && next.nodeType === 1 ? (next.matches(".md-line") ? next : next.querySelector(".md-line")) : null;
        if (lineEl) {
          const lr = lineEl.getBoundingClientRect();
          between = { left: lr.left - 2, right: lr.right, top: lr.top, bottom: lr.bottom };
          rect = { left: lr.left, top: lr.top, bottom: lr.bottom };
        }
      }
    }
  }
  return {
    inside,
    anchor: inside ? editor.mapOffset(sel.anchorNode, sel.anchorOffset) : null,
    focus: inside ? editor.mapOffset(sel.focusNode, sel.focusOffset) : null,
    anchorPath: window.__qaPath(sel.anchorNode) + ":" + sel.anchorOffset,
    focusPath: window.__qaPath(sel.focusNode) + ":" + sel.focusOffset,
    rect: rect ? { x: rect.left, top: rect.top, bottom: rect.bottom } : null,
    // At a soft wrap a collapsed range has a rect on each line; only one has the caret painted.
    rects: range.collapsed ? [...range.getClientRects()].map((r) => ({ x: r.left, top: r.top, bottom: r.bottom })) : [],
    scroll: { x: window.scrollX, y: window.scrollY },
    // A raw list item hangs its marker in the gutter, where the range's rect and the painted
    // caret can disagree. The line's box is scanned for the caret's paint.
    between,
    hanging: (() => {
      if (!range.collapsed || !inside) return null;
      const holder = sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement;
      const line = holder && holder.closest(".md-line.md-raw");
      if (!line || !line.matches(".md-li, .md-ol")) return null;
      const r = line.getBoundingClientRect();
      return { left: r.left - 40, right: r.right, top: r.top, bottom: r.bottom };
    })(),
    fallback,
    emptyLine,
    // A caret where a line wraps belongs to two visual lines at once; which one shows it is a
    // matter of its paint.
    wrap: (() => {
      if (!range.collapsed || !inside) return false;
      const at = editor.mapOffset(sel.focusNode, sel.focusOffset);
      const before = at > 0 ? window.__qaGlyph(at - 1) : null;
      const after = window.__qaGlyph(at);
      return !!before && !!after && Math.abs(after.top - before.top) >= 2;
    })(),
    focused: document.hasFocus() && (document.activeElement === root || root.contains(document.activeElement)),
    raw: [...root.querySelectorAll(".md-raw")].map((el) => el.dataset.start == null ? "?" : el.dataset.start + "-" + el.dataset.end),
  };
};
`;

// Counts pure red pixels in an 8-bit RGB or RGBA PNG without interlace, as Chromium writes them.
function redPixels(png) {
  return redColumns(png).length;
}

// The x of every pixel column that holds pure red.
function redColumns(png) {
  let at = 8;
  let width = 0;
  let height = 0;
  let bpp = 4;
  const idat = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bpp = data[9] === 6 ? 4 : 3;
    }
    if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  let prev = Buffer.alloc(stride);
  const columns = new Set();
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x += 1) {
      const i = x * bpp;
      if (cur[i] > 200 && cur[i + 1] < 60 && cur[i + 2] < 60) columns.add(x);
    }
    prev = cur;
  }
  return [...columns].sort((a, b) => a - b);
}

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

  // Edits this page sent that the hub has not answered yet, by its own doc, a noop, or an error.
  unanswered() {
    let count = 0;
    for (const frame of this.frames) {
      const data = frame.data;
      if (!data) continue;
      if (frame.dir === "out" && (data.type === "edit" || data.type === "undo" || data.type === "redo")) count += 1;
      else if (frame.dir === "in" && ((data.type === "doc" && data.actor === this.user) || data.type === "noop" || data.type === "error")) count = Math.max(0, count - 1);
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

  async caret() {
    const caret = await this.eval("window.__qaCaret()");
    // Where the browser cannot show the caret's paint, a caret that needs it is marked, and the
    // checks that need it are not made.
    if (!supports("paint") && caret && ((caret.rects && caret.rects.length > 1) || caret.wrap || ((caret.hanging || caret.between) && caret.rect))) {
      caret.unpainted = true;
      return caret;
    }
    if (caret && caret.rects && caret.rects.length > 1) {
      const which = await this.paintedRect(caret.rects, caret.scroll);
      if (which != null) caret.rect = caret.rects[which];
      caret.painted = which != null;
    } else if (caret && (caret.hanging || caret.between) && caret.rect) {
      const box = caret.hanging || caret.between;
      const x = await this.paintedX(box, caret.scroll);
      if (x != null) caret.rect = { ...caret.rect, x };
      caret.painted = x != null;
    }
    return caret;
  }

  // Where the red caret is painted along one line's box, in CSS pixels, or null if unseen.
  async paintedX(box, scroll) {
    await this.ensureRedCaret();
    const clip = { x: Math.max(0, box.left + scroll.x), y: box.top + scroll.y, width: Math.max(1, box.right - box.left), height: Math.max(1, box.bottom - box.top), scale: 1 };
    for (let round = 0; round < 10; round += 1) {
      const shot = await this.session.send("Page.captureScreenshot", { format: "png", clip });
      const columns = redColumns(Buffer.from(shot.data, "base64"));
      if (columns.length && columns[columns.length - 1] - columns[0] <= 3) return clip.x - scroll.x + columns[0];
      await sleep(60);
    }
    return null;
  }

  ensureRedCaret() {
    return this.eval(`(() => {
      if (document.getElementById("qa-caret-color")) return;
      const style = document.createElement("style");
      style.id = "qa-caret-color";
      style.textContent = "#editor, #editor * { caret-color: rgb(255, 0, 0) !important; }";
      document.head.appendChild(style);
    })()`);
  }

  // The caret is painted in red, and the rect whose strip holds red pixels is the painted one.
  // The caret blinks, so several rounds of screenshots are taken.
  async paintedRect(rects, scroll) {
    await this.ensureRedCaret();
    for (let round = 0; round < 10; round += 1) {
      const red = [];
      for (const r of rects) {
        const clip = { x: Math.max(0, r.x + scroll.x - 2), y: r.top + scroll.y, width: 5, height: Math.max(1, r.bottom - r.top), scale: 1 };
        const shot = await this.session.send("Page.captureScreenshot", { format: "png", clip });
        red.push(redPixels(Buffer.from(shot.data, "base64")));
      }
      const lit = red.flatMap((n, i) => (n > 0 ? [i] : []));
      if (lit.length === 1) return lit[0];
      await sleep(60);
    }
    return null;
  }

  boundary(offset) {
    return this.eval(`window.__qaBoundary(${offset})`);
  }
}
