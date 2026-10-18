import { lockSpans } from "../src/doc.js";
import { apiUser } from "./harness.js";

// B in the plan's MS cells: the second user, who talks to the hub directly. A browser test
// drives one browser session, so B is never a second page. B clicks into text, which puts its
// caret there and holds that block, and types letters at its caret. B's caret follows the hub's
// doc messages: B's own edit leaves it where the hub says, and another person's edit moves it as
// the hub moves a session's caret (shiftOffset in src/hub.js). What B "sees" on a line is the
// holder the hub's locks message names there.

function shiftOffset(index, from, to, insertedLen) {
  if (index <= from) return index;
  if (index >= to) return index - (to - from) + insertedLen;
  return from + insertedLen;
}

// The offset a click on `what` puts the caret at, from the text alone. `be¦ta` is the place
// marked inside that word. "the third empty line under `one`" is that empty line.
function clickOffset(text, what) {
  let match = /^`([^`]*¦[^`]*)`$/.exec(what) || /^([^`]*¦[^`]*)$/.exec(what);
  if (match) {
    const word = match[1].replace("¦", "");
    const at = text.indexOf(word);
    if (at < 0) throw new Error(`B: ${JSON.stringify(word)} is not in the text`);
    return at + match[1].indexOf("¦");
  }
  match = /^the (first|second|third) empty line under `([^`]+)`$/.exec(what);
  if (match) {
    const nth = ["first", "second", "third"].indexOf(match[1]) + 1;
    let at = text.indexOf("\n", text.indexOf(match[2])) + 1;
    for (let seen = 0; at > 0 && at <= text.length; at = text.indexOf("\n", at) + 1) {
      if (text[at] === "\n") seen += 1;
      if (seen === nth) return at;
      if (text[at] !== "\n") break;
    }
    throw new Error(`B: no ${match[1]} empty line under ${match[2]}`);
  }
  return null;
}

export async function otherUser(port, username) {
  const user = await apiUser(port, username);
  let path = null;
  let text = "";
  let rev = 0;
  let cursor = 0;
  let anchor = 0;
  user.listen((msg) => {
    if (msg.type !== "doc" || msg.path !== path) return;
    text = msg.text;
    rev = msg.rev;
    if (msg.actor === username) {
      cursor = msg.cursor;
      anchor = msg.anchor;
      return;
    }
    for (const change of msg.changes || []) {
      cursor = shiftOffset(cursor, change.from, change.to, change.inserted.length);
      anchor = shiftOffset(anchor, change.from, change.to, change.inserted.length);
    }
  });
  return {
    username,
    async open(file) {
      const opened = await user.open(file);
      path = file;
      text = opened.text;
      rev = opened.rev;
      cursor = anchor = Number.isFinite(opened.cursor) ? opened.cursor : 0;
    },
    // One B action from a cell: a click, or letters typed at B's caret. Anything else is not
    // something B does in the plan.
    async act(action) {
      const click = /^click (.*)$/.exec(action);
      if (click) {
        const at = clickOffset(text, click[1]);
        if (at == null) return { unsupported: action };
        const answer = await user.hold(at);
        // A click into a block another session holds leaves B's caret where it was (R96).
        if (answer.type === "locks") cursor = anchor = at;
        return null;
      }
      if (/^[^\s,]+$/.test(action) && action.length <= 4) {
        for (const ch of action) {
          const answer = await user.insert(cursor, ch);
          if (answer.type !== "doc") break;
        }
        return null;
      }
      return { unsupported: action };
    },
    // Waits until B has heard of every edit the hub has made, up to rev.
    async settle(hubRev) {
      const started = Date.now();
      while (rev < hubRev && Date.now() - started < 3000) await new Promise((resolve) => setTimeout(resolve, 20));
    },
    caret() {
      return { focus: cursor, anchor, none: false, inside: true };
    },
    text() {
      return text;
    },
    // Whether the hub names `name` as the holder of a block whose text contains `words`.
    holds(name, words) {
      const spans = lockSpans(text);
      return user.locks().some((line) => line.username === name && spans[line.index] && text.slice(spans[line.index].start, spans[line.index].end).includes(words));
    },
    close() {
      user.close();
    },
  };
}
