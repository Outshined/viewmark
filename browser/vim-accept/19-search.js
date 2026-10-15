import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "../harness.js";

// The flag is read once, when the editor is created. A later write does not turn keys on.
const VIM = "viewmark.vim";
const TICKET = "7vdep2z4";

function marked(text) {
  const bytes = text.replace(/[‸«]/g, "");
  const focusAt = text.indexOf("‸");
  const anchorAt = text.indexOf("«");
  const position = (at) => at - (anchorAt >= 0 && anchorAt < at ? 1 : 0) - (focusAt >= 0 && focusAt < at ? 1 : 0);
  const focus = focusAt < 0 ? null : position(focusAt);
  const anchor = anchorAt < 0 ? focus : position(anchorAt);
  return { bytes, focus, anchor };
}

function show(text, caret) {
  if (!caret || caret.none || !Number.isInteger(caret.focus)) return `(no caret) ${JSON.stringify(text)}`;
  const focus = caret.focus;
  const anchor = Number.isInteger(caret.anchor) ? caret.anchor : focus;
  let out = "";
  for (let i = 0; i <= text.length; i += 1) {
    if (anchor !== focus && i === anchor) out += "«";
    if (i === focus) out += "‸";
    if (i < text.length) out += text[i];
  }
  return out;
}

function cell(id, fn, timeout) {
  const name = `${id} (ticket ${TICKET})`;
  if (timeout) test(name, { timeout }, fn);
  else test(name, fn);
}

async function boot(t, files) {
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
  return { hub, page };
}

async function at(page, offset) {
  assert.equal(await page.clickOffset(offset), true, `no point at offset ${offset}`);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, offset, `click placed ${caret.focus}, not ${offset}`);
  assert.equal(caret.anchor, offset, `click anchored ${caret.anchor}, not ${offset}`);
}

async function press(page, ...names) {
  for (const name of names) {
    if (Array.isArray(name)) await page.key(name[0], name[1]);
    else await page.key(name);
    await page.quiet();
  }
}

async function span(page, text) {
  for (const ch of text) await page.key(ch);
  await page.quiet();
}

async function line(page) {
  return page.eval(`(() => {
    const field = document.querySelector("input.md-vim-line");
    if (!field) return null;
    return { value: field.value, focused: document.activeElement === field };
  })()`);
}

async function mode(page) {
  return page.eval(`(() => {
    const status = document.querySelector(".md-vim-status");
    return status ? status.textContent : "";
  })()`);
}

async function editorFocused(page) {
  return page.eval(`document.activeElement === document.getElementById("editor")`);
}

async function expectState(hub, page, file, spec, letter, rev) {
  const shown = await hub.show(file);
  const caret = await page.caret();
  const got = show(shown.text, caret);
  assert.equal(got, spec);
  assert.equal(shown.text, marked(spec).bytes);
  assert.equal(shown.rev, rev);
  assert.equal(await mode(page), letter);
  assert.equal(await editorFocused(page), true);
}

// The field's first character is the prompt mark. The pattern is every character after it.
async function openPrompt(page, slash) {
  await page.key(slash);
  await page.quiet();
  const opened = await line(page);
  assert.ok(opened, `${slash} did not open input.md-vim-line`);
  assert.equal(opened.value, slash);
  assert.equal(opened.focused, true);
  return opened;
}

async function find(page, slash, pattern) {
  await openPrompt(page, slash);
  await span(page, pattern);
  const filled = await line(page);
  assert.ok(filled, "the prompt closed while the pattern was typed");
  assert.equal(filled.value, slash + pattern);
  await page.key("Enter");
  await page.quiet();
  assert.equal(await line(page), null, "Enter left the prompt open");
  assert.equal(await editorFocused(page), true);
}

cell("VS.1", async (t) => {
  const file = "a.md";
  const { hub, page } = await boot(t, { [file]: marked("‸alpha beta\n").bytes });
  await page.open(file);
  await at(page, 0);
  const rev = (await hub.show(file)).rev;
  await find(page, "/", "beta");
  await expectState(hub, page, file, "alpha ‸beta\n", "N", rev);
});

cell("VS.2", async (t) => {
  const file = "a.md";
  const start = "alpha beta gam‸ma\n";
  const { hub, page } = await boot(t, { [file]: marked(start).bytes });
  await page.open(file);
  await at(page, marked(start).focus);
  const rev = (await hub.show(file)).rev;
  await find(page, "?", "alpha");
  await expectState(hub, page, file, "‸alpha beta gamma\n", "N", rev);
});

cell("VS.3", async (t) => {
  const file = "a.md";
  const start = "alpha be‸ta\n";
  const { hub, page } = await boot(t, { [file]: marked(start).bytes });
  await page.open(file);
  await at(page, marked(start).focus);
  const rev = (await hub.show(file)).rev;
  await find(page, "/", "alpha");
  await expectState(hub, page, file, "‸alpha beta\n", "N", rev);
});

cell("VS.4", async (t) => {
  const file = "a.md";
  const { hub, page } = await boot(t, { [file]: marked("‸a x b x c x\n").bytes });
  await page.open(file);
  await at(page, 0);
  const rev = (await hub.show(file)).rev;
  await find(page, "/", "x");
  await expectState(hub, page, file, "a ‸x b x c x\n", "N", rev);
  await press(page, "n");
  await expectState(hub, page, file, "a x b ‸x c x\n", "N", rev);
  await press(page, "N");
  await expectState(hub, page, file, "a ‸x b x c x\n", "N", rev);
  await press(page, "n", "n", "n");
  await expectState(hub, page, file, "a ‸x b x c x\n", "N", rev);
});

cell("VS.5", async (t) => {
  const dot = "dot.md";
  const letters = "case.md";
  const { hub, page } = await boot(t, {
    [dot]: marked("‸abc a.c\n").bytes,
    [letters]: marked("‸alpha Alpha\n").bytes,
  });
  await page.open(dot);
  await at(page, 0);
  const dotRev = (await hub.show(dot)).rev;
  await find(page, "/", "a.c");
  await expectState(hub, page, dot, "abc ‸a.c\n", "N", dotRev);

  await page.open(letters);
  await at(page, 0);
  const letterRev = (await hub.show(letters)).rev;
  await find(page, "/", "Alpha");
  await expectState(hub, page, letters, "alpha ‸Alpha\n", "N", letterRev);
});

cell("VS.6", async (t) => {
  const file = "a.md";
  const spec = "‸alpha\n";
  const { hub, page } = await boot(t, { [file]: marked(spec).bytes });
  await page.open(file);
  await at(page, 0);
  const rev = (await hub.show(file)).rev;
  await find(page, "/", "zeta");
  await expectState(hub, page, file, spec, "N", rev);
});

cell("VS.7", async (t) => {
  const accepted = "x".repeat(1000);
  const refused = "x".repeat(1001);
  const yes = "yes.md";
  const no = "no.md";
  const yesBody = `y${accepted}\n`;
  const noBody = `y${refused}\n`;
  const { hub, page } = await boot(t, { [yes]: yesBody, [no]: noBody });

  await page.open(yes);
  await at(page, 0);
  const yesRev = (await hub.show(yes)).rev;
  await find(page, "/", accepted);
  await expectState(hub, page, yes, `y‸${accepted}\n`, "N", yesRev);

  await page.open(no);
  await at(page, 0);
  const noRev = (await hub.show(no)).rev;
  await find(page, "/", refused);
  await expectState(hub, page, no, `‸${noBody}`, "N", noRev);
}, 180000);

cell("VS.8", async (t) => {
  const file = "a.md";
  const spec = "‸alpha beta\n";
  const { hub, page } = await boot(t, { [file]: marked(spec).bytes });
  await page.open(file);
  await at(page, 0);
  const rev = (await hub.show(file)).rev;
  await openPrompt(page, "/");
  await span(page, "beta");
  assert.equal((await line(page)).value, "/beta");
  await page.key("Escape");
  await page.quiet();
  assert.equal(await line(page), null, "Escape left the prompt open");
  await expectState(hub, page, file, spec, "N", rev);
});

cell("VS.9", async (t) => {
  const file = "a.md";
  const spec = "‸alpha beta\n";
  const { hub, page } = await boot(t, { [file]: marked(spec).bytes });
  await page.open(file);
  await at(page, 0);
  const rev = (await hub.show(file)).rev;
  await openPrompt(page, "/");
  await span(page, "beta");
  assert.equal((await line(page)).value, "/beta");
  // The prompt handles the chord on the target. The bubble listener runs after that call.
  await page.eval(`(() => {
    window.__qaPrevented = [];
    window.addEventListener("keydown", (event) => {
      window.__qaPrevented.push({
        key: event.key,
        ctrl: event.ctrlKey === true,
        meta: event.metaKey === true,
        prevented: event.defaultPrevented === true,
      });
    });
  })()`);
  await press(page, ["w", ["Ctrl"]], ["w", ["Meta"]]);
  const prevented = await page.eval(`window.__qaPrevented`);
  const ctrl = prevented.filter((item) => item.ctrl && item.key.toLowerCase() === "w");
  const meta = prevented.filter((item) => item.meta && item.key.toLowerCase() === "w");
  assert.equal(ctrl.length, 1);
  assert.equal(ctrl[0].prevented, true);
  assert.equal(meta.length, 1);
  assert.equal(meta[0].prevented, true);
  const field = await line(page);
  assert.ok(field, "the chord closed the prompt");
  assert.equal(field.value, "/beta");
  assert.equal(await page.eval(`!!document.getElementById("editor")`), true);
  const shown = await hub.show(file);
  assert.equal(shown.text, marked(spec).bytes);
  assert.equal(shown.rev, rev);
});

cell("VS.10", async (t) => {
  const word = "alpha alphabet alpha\n";
  const star = "star.md";
  const gsub = "gsub.md";
  const ghash = "ghash.md";
  const comma = "comma.md";
  const commaStart = "‸alpha, alpha alpha,\n";
  const { hub, page } = await boot(t, {
    [star]: marked(`‸${word}`).bytes,
    [gsub]: marked(`‸${word}`).bytes,
    [ghash]: marked(`alpha alphabet ‸alpha\n`).bytes,
    [comma]: marked(commaStart).bytes,
  });

  await page.open(star);
  await at(page, 0);
  const starRev = (await hub.show(star)).rev;
  await press(page, "*");
  await expectState(hub, page, star, "alpha alphabet ‸alpha\n", "N", starRev);
  await press(page, "#");
  await expectState(hub, page, star, "‸alpha alphabet alpha\n", "N", starRev);

  await page.open(gsub);
  await at(page, 0);
  const gsubRev = (await hub.show(gsub)).rev;
  await press(page, "g", "*");
  await expectState(hub, page, gsub, "alpha ‸alphabet alpha\n", "N", gsubRev);

  await page.open(ghash);
  await at(page, marked("alpha alphabet ‸alpha\n").focus);
  const ghashRev = (await hub.show(ghash)).rev;
  await press(page, "g", "#");
  await expectState(hub, page, ghash, "alpha ‸alphabet alpha\n", "N", ghashRev);

  await page.open(comma);
  await at(page, 0);
  const commaRev = (await hub.show(comma)).rev;
  await press(page, "*");
  await expectState(hub, page, comma, "alpha, alpha ‸alpha,\n", "N", commaRev);
});

cell("VS.11", async (t) => {
  const body = "one two one\n";
  const gn = "gn.md";
  const dgn = "dgn.md";
  const gN = "gN.md";
  const { hub, page } = await boot(t, { [gn]: body, [dgn]: body, [gN]: body });

  await page.open(gn);
  await at(page, 0);
  const gnRev = (await hub.show(gn)).rev;
  await find(page, "/", "two");
  await press(page, "0", "g", "n");
  await expectState(hub, page, gn, "one «two‸ one\n", "V", gnRev);

  await page.open(dgn);
  await at(page, 0);
  const dgnRev = (await hub.show(dgn)).rev;
  await find(page, "/", "two");
  await press(page, "0", "d", "g", "n");
  await expectState(hub, page, dgn, "‸one two one\n", "N", dgnRev);

  await page.open(gN);
  await at(page, 0);
  const gNRev = (await hub.show(gN)).rev;
  await find(page, "/", "two");
  await press(page, "$", "g", "N");
  await expectState(hub, page, gN, "one ‸two« one\n", "V", gNRev);
});

cell("VS.12", async (t) => {
  const file = "a.md";
  const { hub, page } = await boot(t, { [file]: marked("‸alpha beta\n").bytes });
  await page.open(file);
  await at(page, 0);
  const rev = (await hub.show(file)).rev;
  await find(page, "/", "beta");
  await expectState(hub, page, file, "alpha ‸beta\n", "N", rev);
  const marks = await page.eval(`(() => {
    const hits = [];
    for (const el of document.querySelectorAll("*")) {
      const cls = typeof el.className === "string" ? el.className : "";
      if (el.tagName === "MARK") hits.push("MARK");
      if (/(^|\\s)(md-search|md-find|md-match|md-vim-match|hlsearch|vim-hit)(\\s|$)/.test(cls)) hits.push(cls);
      if (el.dataset && (Object.hasOwn(el.dataset, "match") || Object.hasOwn(el.dataset, "search"))) hits.push(el.tagName);
    }
    return hits;
  })()`);
  assert.deepEqual(marks, []);
  await openPrompt(page, "/");
  assert.equal((await line(page)).value, "/");
  await page.key("↑");
  await page.quiet();
  const field = await line(page);
  assert.ok(field, "ArrowUp closed the prompt");
  assert.equal(field.value, "/");
  const shown = await hub.show(file);
  assert.equal(shown.text, "alpha beta\n");
  assert.equal(shown.rev, rev);
});
