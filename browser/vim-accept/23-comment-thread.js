import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, REPO, startHub } from "../harness.js";

const VIM = "viewmark.vim";

const OWN = "See {c1}mine{/c1} now.\n\n```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z qa-bot\nMine.\n```\n";
const OTHER = "See {c1}them{/c1}.\n\n```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z qa-two\nTheirs.\n:: 1\n@2026-10-05T16:05:00.000Z qa-bot\nfirst.\n:: 2\n@2026-10-05T16:06:00.000Z qa-bot\nsecond.\n```\n";
const NONE = "See {c1}lone{/c1}.\n\n```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z qa-two\nOnly.\n```\n";
const PLAIN = "alpha beta\n";

async function setup(t, files) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  for (const [name, text] of Object.entries(files)) await hub.create(name, text);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
  await page.login();
  await page.session.send("Browser.grantPermissions", {
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    origin: `http://127.0.0.1:${hub.port}`,
  });
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  return { hub, page };
}

function status(page) {
  return page.eval(`(() => {
    const el = document.querySelector("span.md-vim-status");
    return el ? el.textContent : "";
  })()`);
}

function currentComment(page) {
  return page.eval(`(() => {
    const card = document.querySelector(".md-comment-card.md-comment-current");
    return card && card.dataset ? (card.dataset.comment || "") : "";
  })()`);
}

function noteBox(page) {
  return page.eval(`(() => {
    const el = document.activeElement;
    if (!el || el.tagName !== "TEXTAREA" || !el.classList.contains("md-comment-body")) return null;
    return {
      value: el.value,
      reply: el.dataset.reply || "",
      editing: el.dataset.editing || "",
      note: el.dataset.note || "",
      comment: el.dataset.comment || "",
    };
  })()`);
}

function editorFocused(page) {
  return page.eval(`(() => {
    const el = document.activeElement;
    const editor = document.getElementById("editor");
    return !!(el && editor && (el === editor || editor.contains(el)));
  })()`);
}

function textareaCount(page) {
  return page.eval(`document.querySelectorAll("textarea.md-comment-body").length`);
}

async function place(page, offset) {
  assert.equal(await page.clickOffset(offset), true, `no point at ${offset}`);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, offset, `caret ${caret && caret.focus} after click at ${offset}`);
  assert.equal(caret.anchor, offset, `anchor ${caret && caret.anchor} after click at ${offset}`);
}

async function openFile(page, file) {
  await page.open(file);
  await page.until(() => page.eval(`!!document.querySelector("span.md-vim-status")`), "vim status");
}

// A click on the highlight selects the card. Escape drops that and leaves the caret.
async function arm(page, offset) {
  await place(page, offset);
  await page.key("Escape");
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, offset, `escape moved the caret to ${caret && caret.focus}`);
  assert.equal(caret.anchor, offset, `escape anchor ${caret && caret.anchor}`);
  assert.equal(await currentComment(page), "");
  assert.equal(await status(page), "N");
}

async function press(page, name, mods) {
  await page.key(name, mods);
  await page.quiet();
}

async function untilText(page, hub, file, pred, what) {
  let shown = null;
  await page.until(async () => {
    shown = await hub.show(file);
    return pred(shown.text);
  }, what);
  await page.quiet();
  return shown;
}

async function readClipboard(page) {
  const out = await page.session.send("Runtime.evaluate", {
    expression: "navigator.clipboard.readText()",
    awaitPromise: true,
    userGesture: true,
    returnByValue: true,
  });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || "clipboard read failed");
  return out.result.value;
}

async function writeClipboard(page, text) {
  const out = await page.session.send("Runtime.evaluate", {
    expression: `navigator.clipboard.writeText(${JSON.stringify(text)})`,
    awaitPromise: true,
    userGesture: true,
    returnByValue: true,
  });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || "clipboard write failed");
}

async function untilClipboard(page, want) {
  let text = "";
  await page.until(async () => {
    try {
      text = await readClipboard(page);
    } catch {
      return false;
    }
    return text === want;
  }, `clipboard ${want}, last ${JSON.stringify(text)}`);
  return text;
}

async function motionMoves(page, label) {
  assert.equal(await editorFocused(page), true, `${label} editor focus`);
  const before = await page.caret();
  await press(page, "l");
  let after = await page.caret();
  if (after.focus === before.focus) {
    await press(page, "h");
    after = await page.caret();
  }
  assert.notEqual(after.focus, before.focus, `${label} motion stayed at ${before.focus}`);
}

async function offsetOf(hub, file, word) {
  const shown = await hub.show(file);
  const at = shown.text.indexOf(word);
  assert.ok(at >= 0, `${word} missing in ${JSON.stringify(shown.text)}`);
  return at;
}

test("gc opens the comment under the caret for thread commands", { timeout: 180000 }, async (t) => {
  const { hub, page } = await setup(t, {
    "own.md": OWN,
    "other.md": OTHER,
    "none.md": NONE,
    "plain.md": PLAIN,
  });

  await openFile(page, "own.md");
  await arm(page, await offsetOf(hub, "own.md", "mine"));
  let shown = await hub.show("own.md");
  await press(page, "g");
  await press(page, "c");
  let after = await hub.show("own.md");
  assert.equal(after.text, shown.text);
  assert.equal(after.rev, shown.rev);
  assert.equal(await currentComment(page), "c1");
  assert.equal(await status(page), "N");
  await press(page, "l");
  assert.equal(await currentComment(page), "c1");
  await press(page, "Escape");
  assert.equal(await currentComment(page), "");
  assert.equal(await status(page), "N");
  await motionMoves(page, "escape after gc");

  await arm(page, await offsetOf(hub, "own.md", "mine"));
  shown = await hub.show("own.md");
  await press(page, "v");
  await press(page, "g");
  await press(page, "c");
  after = await hub.show("own.md");
  assert.equal(after.text, shown.text, "visual gc inside a comment added one");
  assert.equal(after.rev, shown.rev);
  assert.equal(await currentComment(page), "c1");
  assert.equal(await status(page), "V");
  await press(page, "Escape");
  assert.equal(await currentComment(page), "");
  assert.equal(await status(page), "N");
  await motionMoves(page, "escape after visual gc");

  await arm(page, await offsetOf(hub, "own.md", "mine"));
  shown = await hub.show("own.md");
  await press(page, "g");
  await press(page, "c");
  await press(page, "r");
  let note = await noteBox(page);
  assert.ok(note, "reply did not take focus");
  assert.equal(note.reply, "true");
  assert.equal(note.value, "");
  assert.equal(await status(page), "N");
  await page.type("nope");
  note = await noteBox(page);
  assert.equal(note && note.value, "nope");
  await press(page, "Escape");
  after = await hub.show("own.md");
  assert.equal(after.text, shown.text, "escape saved the reply");
  assert.equal(after.rev, shown.rev);
  assert.equal(await textareaCount(page), 0);
  assert.equal(await currentComment(page), "");
  assert.equal(await status(page), "N");
  await motionMoves(page, "escape discards a reply");

  await arm(page, await offsetOf(hub, "own.md", "mine"));
  await press(page, "g");
  await press(page, "c");
  await press(page, "r");
  await page.type("hello");
  note = await noteBox(page);
  assert.equal(note && note.value, "hello");
  await page.key("Enter", ["Ctrl"]);
  after = await untilText(page, hub, "own.md", (text) => text.includes("hello") && text.includes("Mine.") && (text.match(/```comment c1\b/g) || []).length === 1, "saved reply");
  assert.equal(await status(page), "N");
  await motionMoves(page, "after reply save");
  await press(page, "Escape");
  assert.equal(await currentComment(page), "");
  assert.equal(await status(page), "N");
  await motionMoves(page, "escape after a saved reply");

  await arm(page, await offsetOf(hub, "own.md", "mine"));
  await press(page, "g");
  await press(page, "c");
  const link = `#${REPO}/comment/own.md/c1`;
  const wantLink = await page.eval(`location.origin + location.pathname + ${JSON.stringify(link)}`);
  await writeClipboard(page, "before");
  await press(page, "Y");
  assert.equal(await untilClipboard(page, wantLink), wantLink);
  after = await hub.show("own.md");
  assert.equal(after.text.includes("hello"), true);

  await press(page, "R");
  await untilText(page, hub, "own.md", (text) => text.includes("```comment c1 resolved"), "resolve");
  await press(page, "R");
  await untilText(page, hub, "own.md", (text) => text.includes("```comment c1\n") && !text.includes("resolved"), "reopen");
  assert.equal(await currentComment(page), "c1");
  await press(page, "X");
  after = await untilText(page, hub, "own.md", (text) => text === "See mine now.\n", "delete");
  assert.equal(after.text, "See mine now.\n");
  assert.equal(await status(page), "N");
  await motionMoves(page, "after delete");

  await openFile(page, "other.md");
  await arm(page, await offsetOf(hub, "other.md", "them"));
  shown = await hub.show("other.md");
  await press(page, "g");
  await press(page, "c");
  after = await hub.show("other.md");
  assert.equal(after.text, shown.text);
  assert.equal(after.rev, shown.rev);
  assert.equal(await currentComment(page), "c1");
  await press(page, "R");
  after = await hub.show("other.md");
  assert.equal(after.text, shown.text, "a later reply's author resolved the thread");
  assert.equal(after.rev, shown.rev);
  assert.equal(await currentComment(page), "c1");
  await press(page, "X");
  after = await hub.show("other.md");
  assert.equal(after.text, shown.text, "a later reply's author deleted the thread");
  assert.equal(await currentComment(page), "c1");
  const otherLink = await page.eval(`location.origin + location.pathname + ${JSON.stringify(`#${REPO}/comment/other.md/c1`)}`);
  await writeClipboard(page, "before");
  await press(page, "Y");
  assert.equal(await untilClipboard(page, otherLink), otherLink);
  await press(page, "i");
  note = await noteBox(page);
  assert.ok(note, "own note did not take focus");
  assert.equal(note.editing, "true");
  assert.equal(note.note, "1");
  assert.equal(note.value, "first.");
  await page.type("x");
  note = await noteBox(page);
  assert.equal(note && note.value, "first.x");
  await press(page, "Escape");
  after = await hub.show("other.md");
  assert.equal(after.text, shown.text, "escape saved the revision");
  assert.equal(await textareaCount(page), 0);
  assert.equal(await currentComment(page), "");
  assert.equal(await status(page), "N");
  await motionMoves(page, "escape discards a revision");

  await arm(page, await offsetOf(hub, "other.md", "them"));
  await press(page, "g");
  await press(page, "c");
  await press(page, "i");
  note = await noteBox(page);
  assert.equal(note && note.value, "first.");
  await page.type("x");
  await page.key("Enter", ["Ctrl"]);
  after = await untilText(page, hub, "other.md", (text) => text.includes("first.x") && text.includes("Theirs.") && text.includes("second."), "saved revision");
  assert.equal(after.text.includes("Theirs."), true);
  assert.equal(await status(page), "N");
  await motionMoves(page, "after revision save");

  await openFile(page, "none.md");
  await arm(page, await offsetOf(hub, "none.md", "lone"));
  shown = await hub.show("none.md");
  await press(page, "g");
  await press(page, "c");
  assert.equal(await currentComment(page), "c1");
  await press(page, "i");
  assert.equal(await noteBox(page), null);
  assert.equal(await textareaCount(page), 0);
  assert.equal(await status(page), "N");
  assert.equal(await currentComment(page), "c1");
  after = await hub.show("none.md");
  assert.equal(after.text, shown.text);
  await press(page, "r");
  note = await noteBox(page);
  assert.equal(note && note.reply, "true");
  await page.type("z");
  await press(page, "Escape");
  after = await hub.show("none.md");
  assert.equal(after.text, shown.text);
  assert.equal(await currentComment(page), "");
  assert.equal(await status(page), "N");

  await openFile(page, "plain.md");
  await arm(page, 0);
  shown = await hub.show("plain.md");
  await press(page, "g");
  await press(page, "c");
  after = await hub.show("plain.md");
  assert.equal(after.text, PLAIN);
  assert.equal(after.rev, shown.rev);
  assert.equal(await currentComment(page), "");
  await press(page, "r");
  await press(page, "z");
  after = await hub.show("plain.md");
  assert.equal(after.text, "zlpha beta\n");
  await press(page, "u");
  after = await hub.show("plain.md");
  assert.equal(after.text, PLAIN);
  await place(page, 0);
  await press(page, "v");
  await press(page, "e");
  await press(page, "g");
  await press(page, "c");
  after = await untilText(page, hub, "plain.md", (text) => text.includes("{c1}alpha{/c1}"), "visual gc adds a comment");
  assert.equal(after.text, "{c1}alpha{/c1} beta\n\n```comment c1\n\n```\n");
  assert.equal(await status(page), "V");
});
