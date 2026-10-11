import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { onPath, spawnTied, stopProcess } from "./harness.js";

// Firefox for the browser tests, over WebDriver BiDi. A FirefoxSession takes the DevTools
// protocol calls the harness and the tests make, and does each one in Firefox, so the same tests
// run in either browser. VIEWMARK_BROWSER=firefox selects it.
//
// Firefox runs inside cage, a Wayland compositor with a headless backend, when cage is
// installed: Firefox is then a real window with its own clipboard, which holds pictures, and the
// person's screen and clipboard are not touched. Without cage it runs with --headless, where the
// clipboard holds text only. VIEWMARK_HEADED=1 shows it on the person's display.

const FIREFOX = process.env.VIEWMARK_FIREFOX || "firefox";
const CAGE = process.env.VIEWMARK_CAGE || "cage";
const VIEWPORT = { width: 1200, height: 900 };

const PREFS = {
  "browser.shell.checkDefaultBrowser": false,
  "browser.startup.page": 0,
  "browser.startup.homepage": "about:blank",
  "startup.homepage_welcome_url": "",
  "browser.aboutwelcome.enabled": false,
  "browser.tabs.warnOnClose": false,
  "browser.warnOnQuit": false,
  "browser.sessionstore.resume_from_crash": false,
  "datareporting.policy.dataSubmissionEnabled": false,
  "toolkit.telemetry.reportingpolicy.firstRun": false,
  "dom.disable_beforeunload": true,
  // The clipboard API without a prompt, as Chromium's granted permission gives.
  "dom.events.testing.asyncClipboard": true,
  "dom.events.asyncClipboard.clipboardItem": true,
  "general.smoothScroll": false,
  "layout.css.devPixelsPerPx": "1.0",
  // A caret that does not blink, so a screenshot always finds it painted.
  "ui.caretBlinkTime": 0,
};

// The DevTools key names the harness sends, as WebDriver key values.
const KEY_VALUES = {
  Enter: "", Backspace: "", Delete: "", Tab: "", Escape: "",
  ArrowLeft: "", ArrowUp: "", ArrowRight: "", ArrowDown: "",
  Home: "", End: "", PageUp: "", PageDown: "", Insert: "",
};
// DevTools modifier bits and their WebDriver keys.
const MODIFIER_KEYS = [[1, ""], [2, ""], [4, ""], [8, ""]];
const BUTTONS = { left: 0, middle: 1, right: 2 };

// Reports the page's socket frames over a BiDi channel, in the shape of the DevTools network
// events. It wraps the WebSocket constructor and send, and changes nothing the page sees.
const BRIDGE = String.raw`(qa) => {
  const report = (o) => { try { qa(JSON.stringify(o)); } catch {} };
  const b64 = (u) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const Native = window.WebSocket;
  const send = Native.prototype.send;
  Native.prototype.send = function (data) {
    if (typeof data === "string") report({ dir: "out", opcode: 1, payload: data });
    else if (ArrayBuffer.isView(data)) report({ dir: "out", opcode: 2, payload: b64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) });
    else if (data instanceof ArrayBuffer) report({ dir: "out", opcode: 2, payload: b64(new Uint8Array(data)) });
    return send.call(this, data);
  };
  window.WebSocket = new Proxy(Native, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget);
      socket.addEventListener("message", (event) => {
        report(typeof event.data === "string" ? { dir: "in", opcode: 1, payload: event.data } : { dir: "in", opcode: 2, payload: "" });
      });
      return socket;
    },
  });
}`;

// A BiDi remote value as a plain value, as the DevTools protocol's returnByValue gives it.
function plain(value) {
  if (!value) return undefined;
  switch (value.type) {
    case "undefined": return undefined;
    case "null": return null;
    case "string": case "boolean": return value.value;
    case "number": return typeof value.value === "number" ? value.value : Number(value.value);
    case "bigint": return Number(value.value);
    case "array": case "set": return (value.value || []).map(plain);
    case "object": case "map": return Object.fromEntries((value.value || []).map(([key, item]) => [typeof key === "string" ? key : plain(key), plain(item)]));
    case "date": case "regexp": return value.value;
    default: return {};
  }
}

function unsupported(method) {
  const err = new Error(`${method} has no WebDriver BiDi counterpart in Firefox`);
  err.unsupported = true;
  return err;
}

class Bidi {
  constructor(ws) {
    this.ws = ws;
    this.next = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id != null && this.pending.has(message.id)) {
        const { resolve, reject, method } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.type === "error") reject(new Error(`${method}: ${message.error}: ${message.message}`));
        else resolve(message.result);
        return;
      }
      if (message.type === "event") for (const fn of this.listeners) fn(message);
    });
  }

  send(method, params = {}) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

export class FirefoxSession {
  constructor(bidi, context) {
    this.bidi = bidi;
    this.context = context;
    this.listeners = new Map();
    this.modifiers = 0;
    this.nodes = new Map();
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method).delete(fn);
  }

  emit(method, params) {
    for (const fn of this.listeners.get(method) || []) fn(params);
  }

  // A BiDi event for this tab, in the shape of the DevTools event the harness listens for.
  receive(event) {
    const { method, params } = event;
    if (method === "script.message" && params.channel === "viewmark-qa-frames") {
      let frame = null;
      try {
        frame = JSON.parse(plain(params.data));
      } catch {
        return;
      }
      this.emit(frame.dir === "out" ? "Network.webSocketFrameSent" : "Network.webSocketFrameReceived", { response: { opcode: frame.opcode, payloadData: frame.payload } });
    } else if (method === "log.entryAdded" && params.type === "javascript") {
      this.emit("Runtime.exceptionThrown", { exceptionDetails: { text: params.text } });
    } else if (method === "network.beforeRequestSent") {
      this.emit("Network.requestWillBeSent", { request: { url: params.request.url, method: params.request.method } });
    }
  }

  async evaluate(expression, { userActivation = false, own = false } = {}) {
    return this.bidi.send("script.evaluate", {
      expression,
      target: { context: this.context },
      awaitPromise: true,
      userActivation,
      resultOwnership: own ? "root" : "none",
      serializationOptions: { maxDomDepth: 0, maxObjectDepth: 64 },
    });
  }

  // Presses or releases modifier keys until exactly the DevTools bits are held.
  modifierActions(bits = 0) {
    const actions = [];
    for (const [bit, key] of MODIFIER_KEYS) {
      if ((bits & bit) && !(this.modifiers & bit)) actions.push({ type: "keyDown", value: key });
      if (!(bits & bit) && (this.modifiers & bit)) actions.push({ type: "keyUp", value: key });
    }
    this.modifiers = bits;
    return actions;
  }

  keys(actions) {
    if (!actions.length) return Promise.resolve();
    return this.bidi.send("input.performActions", { context: this.context, actions: [{ type: "key", id: "keyboard", actions }] });
  }

  pointer(actions) {
    return this.bidi.send("input.performActions", { context: this.context, actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }] });
  }

  async send(method, params = {}) {
    // Keys and the mouse go to the tab in front, as a person brings a tab forward to use it.
    if (method.startsWith("Input.") && this.bringForward) await this.bringForward();
    switch (method) {
      case "Page.enable": case "Runtime.enable": case "Network.enable": case "DOM.enable": case "CSS.enable":
      case "Emulation.setFocusEmulationEnabled": case "Browser.grantPermissions":
        return {};
      case "Page.addScriptToEvaluateOnNewDocument": {
        const made = await this.bidi.send("script.addPreloadScript", { functionDeclaration: `() => {\n${params.source}\n}`, contexts: [this.context] });
        return { identifier: made.script };
      }
      case "Runtime.evaluate": {
        const result = await this.evaluate(params.expression, { userActivation: !!params.userGesture });
        if (result.type === "exception") return { result: { type: "undefined" }, exceptionDetails: { text: result.exceptionDetails.text, exception: { description: result.exceptionDetails.text } } };
        return { result: { type: result.result.type, value: plain(result.result) } };
      }
      case "Page.navigate":
        await this.bidi.send("browsingContext.navigate", { context: this.context, url: params.url, wait: "interactive" });
        return {};
      case "Page.reload":
        if (params.ignoreCache && this.forcedReload) {
          await this.forcedReload();
          return {};
        }
        await this.bidi.send("browsingContext.reload", { context: this.context, wait: "interactive" });
        return {};
      case "Page.captureScreenshot": {
        const clip = params.clip;
        const shot = await this.bidi.send("browsingContext.captureScreenshot", {
          context: this.context,
          origin: "document",
          format: { type: "image/png" },
          ...(clip ? { clip: { type: "box", x: clip.x, y: clip.y, width: Math.max(1, clip.width), height: Math.max(1, clip.height) } } : {}),
        });
        return { data: shot.data };
      }
      case "Emulation.setDeviceMetricsOverride":
        await this.bidi.send("browsingContext.setViewport", { context: this.context, viewport: { width: params.width, height: params.height } });
        return {};
      case "Emulation.clearDeviceMetricsOverride":
        await this.bidi.send("browsingContext.setViewport", { context: this.context, viewport: VIEWPORT });
        return {};
      case "Input.dispatchKeyEvent": {
        const value = KEY_VALUES[params.key] || ([...(params.key || "")].length === 1 ? params.key : null);
        if (!value) throw unsupported(`Input.dispatchKeyEvent for ${params.key}`);
        const down = params.type === "keyDown" || params.type === "rawKeyDown" || params.type === "char";
        await this.keys([...this.modifierActions(params.modifiers || 0), { type: down ? "keyDown" : "keyUp", value }]);
        return {};
      }
      case "Input.insertText":
        await this.keys([...this.modifierActions(0), ...[...params.text].flatMap((ch) => [{ type: "keyDown", value: ch }, { type: "keyUp", value: ch }])]);
        return {};
      case "Input.dispatchMouseEvent": {
        await this.keys(this.modifierActions(params.modifiers || 0));
        if (params.type === "mouseMoved") await this.pointer([{ type: "pointerMove", x: params.x, y: params.y }]);
        else if (params.type === "mousePressed") await this.pointer([{ type: "pointerMove", x: params.x, y: params.y }, { type: "pointerDown", button: BUTTONS[params.button] ?? 0 }]);
        else if (params.type === "mouseReleased") await this.pointer([{ type: "pointerMove", x: params.x, y: params.y }, { type: "pointerUp", button: BUTTONS[params.button] ?? 0 }]);
        else if (params.type === "mouseWheel") {
          await this.bidi.send("input.performActions", { context: this.context, actions: [{ type: "wheel", id: "wheel", actions: [{ type: "scroll", x: Math.round(params.x), y: Math.round(params.y), deltaX: Math.round(params.deltaX || 0), deltaY: Math.round(params.deltaY || 0) }] }] });
        } else throw unsupported(`Input.dispatchMouseEvent ${params.type}`);
        return {};
      }
      case "DOM.getDocument":
        return { root: { nodeId: 0 } };
      case "DOM.querySelector": {
        const found = await this.evaluate(`!!document.querySelector(${JSON.stringify(params.selector)})`);
        if (!plain(found.result)) return { nodeId: 0 };
        const id = this.nodes.size + 1;
        this.nodes.set(id, params.selector);
        return { nodeId: id };
      }
      case "DOM.setFileInputFiles": {
        const selector = this.nodes.get(params.nodeId);
        const node = await this.evaluate(`document.querySelector(${JSON.stringify(selector)})`, { own: true });
        await this.bidi.send("input.setFiles", { context: this.context, element: { sharedId: node.result.sharedId }, files: params.files });
        return {};
      }
      default:
        throw unsupported(method);
    }
  }
}

function prefsFile(profile) {
  const lines = Object.entries(PREFS).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`);
  writeFileSync(path.join(profile, "user.js"), lines.join("\n") + "\n");
}

// Waits for the line where Firefox names its BiDi socket, and keeps draining the pipes.
function bidiAddress(proc) {
  return new Promise((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => reject(new Error(`Firefox did not open WebDriver BiDi: ${seen.slice(-400)}`)), 30000);
    const read = (chunk) => {
      if (seen === null) return;
      seen += chunk;
      const match = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(seen);
      if (match) {
        clearTimeout(timer);
        seen = null;
        resolve(match[1].replace(/\/$/, ""));
      }
    };
    proc.stdout.on("data", read);
    proc.stderr.on("data", read);
    proc.once("exit", () => reject(new Error(`Firefox exited: ${seen && seen.slice(-400)}`)));
  });
}

export async function launchFirefox() {
  const profile = mkdtempSync(path.join(tmpdir(), "viewmark-qa-ff-profile-"));
  prefsFile(profile);
  const keep = process.env.VIEWMARK_KEEP_PROFILE === "1";
  const headed = process.env.VIEWMARK_HEADED === "1";
  const caged = !headed && onPath(CAGE);
  const args = ["--remote-debugging-port", "0", "-remote-allow-system-access", "--no-remote", "--profile", profile];
  let proc;
  let runtime = null;
  if (caged) {
    runtime = mkdtempSync(path.join(tmpdir(), "viewmark-qa-ff-xdg-"));
    const env = { WLR_BACKENDS: "headless", WLR_LIBINPUT_NO_DEVICES: "1", WLR_RENDERER: "pixman", XDG_RUNTIME_DIR: runtime, MOZ_ENABLE_WAYLAND: "1", DISPLAY: "", WAYLAND_DISPLAY: "" };
    proc = spawnTied(CAGE, ["--", FIREFOX, ...args], "pipe", "pipe", keep ? [runtime] : [profile, runtime], env);
  } else {
    proc = spawnTied(FIREFOX, [...args, ...(headed ? [] : ["--headless"]), "--width", String(VIEWPORT.width), "--height", String(VIEWPORT.height)], "pipe", "pipe", keep ? [] : [profile]);
  }
  const address = await bidiAddress(proc);
  const ws = new WebSocket(`${address}/session`);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const bidi = new Bidi(ws);
  await bidi.send("session.new", { capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: "ignore" } } } });
  await bidi.send("session.subscribe", { events: ["log.entryAdded", "script.message", "network.beforeRequestSent"] });
  const sessions = new Map();
  let front = null;
  bidi.listeners.add((event) => {
    const context = event.params.source?.context || event.params.context;
    const session = sessions.get(context);
    if (session) session.receive(event);
  });

  // The first tab is privileged (about:home), so every test tab is one this harness made.
  const startup = (await bidi.send("browsingContext.getTree", { maxDepth: 0 })).contexts.map((item) => item.context);
  async function tab() {
    const { context } = await bidi.send("browsingContext.create", { type: "tab" });
    front = context;
    await bidi.send("browsingContext.setViewport", { context, viewport: VIEWPORT });
    await bidi.send("script.addPreloadScript", { functionDeclaration: BRIDGE, arguments: [{ type: "channel", value: { channel: "viewmark-qa-frames" } }], contexts: [context] });
    const session = new FirefoxSession(bidi, context);
    // BiDi cannot skip the cache on a reload yet, so a forced reload is the browser's own
    // command, as Ctrl+Shift+R runs it, and then the new document is awaited.
    session.forcedReload = async () => {
      await session.evaluate("window.__qaBeforeReload = true");
      await bidi.send("browsingContext.activate", { context });
      await chrome("BrowserCommands.reloadSkipCache(), true");
      for (let i = 0; i < 200; i += 1) {
        const now = await session.evaluate("!window.__qaBeforeReload && document.readyState !== 'loading'").catch(() => null);
        if (now && now.type === "success" && now.result.value === true) return;
        await sleep(25);
      }
      throw new Error("the forced reload did not load a new document");
    };
    session.bringForward = async () => {
      if (front === context) return;
      await bidi.send("browsingContext.activate", { context });
      front = context;
    };
    sessions.set(context, session);
    return { session, targetId: context };
  }
  const first = await tab();
  front = first.targetId;
  for (const context of startup) await bidi.send("browsingContext.close", { context }).catch(() => {});

  // The browser's own window, for what only its chrome can do, such as the Copy Image menu item.
  async function chrome(expression) {
    const tree = await bidi.send("browsingContext.getTree", { "moz:scope": "chrome" });
    const result = await bidi.send("script.evaluate", { expression, target: { context: tree.contexts[0].context }, awaitPromise: true, resultOwnership: "none" });
    if (result.type === "exception") throw new Error(`chrome: ${result.exceptionDetails.text}`);
    return plain(result.result);
  }

  return {
    name: "firefox",
    caged,
    session: first.session,
    targetId: first.targetId,
    newSession: tab,
    async openBlank() {
      return (await tab()).targetId;
    },
    async activate(id) {
      await bidi.send("browsingContext.activate", { context: id });
      front = id;
    },
    async closeTarget(id) {
      sessions.delete(id);
      await bidi.send("browsingContext.close", { context: id });
    },
    chrome,
    // A right-click at a point in a tab, then the context menu item with this id, as a person
    // chooses Copy Image.
    async contextMenu(session, x, y, item) {
      await session.pointer([{ type: "pointerMove", x, y }, { type: "pointerDown", button: 2 }, { type: "pointerUp", button: 2 }]);
      for (let i = 0; i < 50; i += 1) {
        if (await chrome(`document.getElementById("contentAreaContextMenu").state === "open"`)) break;
        await sleep(50);
      }
      const done = await chrome(`(() => {
        const menu = document.getElementById("contentAreaContextMenu");
        const entry = document.getElementById(${JSON.stringify(item)});
        const usable = menu.state === "open" && entry && !entry.hidden && !entry.disabled;
        if (usable) entry.doCommand();
        menu.hidePopup();
        return usable;
      })()`);
      if (!done) throw new Error(`the context menu has no usable ${item}`);
    },
    async close() {
      try {
        await bidi.send("session.end");
      } catch {}
      ws.close();
      await stopProcess(proc);
      if (!keep) {
        rmSync(profile, { recursive: true, force: true });
        if (runtime) rmSync(runtime, { recursive: true, force: true });
      }
    },
  };
}
