import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The plan in the hub is authoritative. Every run reads its cells from there; there is no copy.
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const PLAN = { repo: "viewmark", path: "qa/editor-matrix-test-plan.md" };
const CM = "\n\n```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nNote.\n```\n";
const LITERAL = /`([^`]*)`|"((?:[^"\\]|\\.)*)"/y;

function decodeBackticks(body) {
  return body.replace(/\\([nt\\])/g, (_, ch) => (ch === "n" ? "\n" : ch === "t" ? "\t" : "\\"));
}

function readLiteral(text, at) {
  LITERAL.lastIndex = at;
  const match = LITERAL.exec(text);
  if (!match) return null;
  const value = match[1] != null ? decodeBackticks(match[1]) : JSON.parse(`"${match[2]}"`);
  return { value, end: LITERAL.lastIndex };
}

// The plan's named texts. LONG@n is LONG with the caret after its n-th character.
const LONG = `${"alpha beta gamma delta ".repeat(15)}end`;
const NAMES = {
  CM,
  LONG,
  URL: `https://x.test/${"a".repeat(385)}`,
  FILL: Array.from({ length: 60 }, (_, i) => `filler ${i + 1}\n\n`).join(""),
};
const NAME = /(CM|LONG|URL|FILL)(?:@(\d+))?/y;
export const FILL = NAMES.FILL;

// A source or an expectation: literals and names joined by " + ".
function readPieces(text, at) {
  let value = "";
  let end = at;
  for (;;) {
    const literal = readLiteral(text, end);
    if (literal) {
      value += literal.value;
      end = literal.end;
    } else {
      NAME.lastIndex = end;
      const name = NAME.exec(text);
      if (!name) break;
      const named = NAMES[name[1]];
      value += name[2] == null ? named : named.slice(0, Number(name[2])) + "‸" + named.slice(Number(name[2]));
      end = NAME.lastIndex;
    }
    if (!text.startsWith(" + ", end)) break;
    end += 3;
  }
  return end === at ? null : { value, end };
}

// The marks are not file bytes: ‸ is the focus and « the anchor.
export function marked(text) {
  const bytes = text.replace(/[‸«]/g, "");
  const focusAt = text.indexOf("‸");
  const anchorAt = text.indexOf("«");
  const position = (at) => at - (anchorAt >= 0 && anchorAt < at ? 1 : 0) - (focusAt >= 0 && focusAt < at ? 1 : 0);
  const focus = focusAt < 0 ? null : position(focusAt);
  const anchor = anchorAt < 0 ? focus : position(anchorAt);
  return { bytes, focus, anchor };
}

const ACTIONS = /^(?:Shift\+click|middle-click|click|dblclick|tripleclick|drag|compose|commit) /;

// Comma-separated keys. A token that is only a literal is typed text, a token that starts with
// a pointer or IME verb is an action, and anything else is a key. A compose takes the bare
// literals after it as further steps.
function splitKeys(text) {
  const tokens = [];
  let at = 0;
  let current = "";
  const push = () => {
    const raw = current.trim();
    current = "";
    if (raw) tokens.push(raw);
  };
  while (at < text.length) {
    if (text[at] === '"' || text[at] === "`") {
      const literal = readLiteral(text, at);
      if (literal) {
        current += text.slice(at, literal.end);
        at = literal.end;
        continue;
      }
    }
    if (text.startsWith(", ", at)) {
      push();
      at += 2;
      continue;
    }
    current += text[at];
    at += 1;
  }
  push();
  const keys = [];
  for (const raw of tokens) {
    const whole = readLiteral(raw, 0);
    const previous = keys[keys.length - 1];
    if (whole && whole.end === raw.length) {
      if (previous && previous.compose && !previous.commit) previous.compose.push(whole.value);
      else keys.push({ text: whole.value });
    } else if (raw.startsWith("compose ")) {
      keys.push({ compose: [readLiteral(raw, 8).value] });
    } else if (raw.startsWith("commit ") && previous && previous.compose) {
      previous.commit = readLiteral(raw, 7).value;
    } else if (ACTIONS.test(raw)) {
      keys.push({ action: raw });
    } else {
      keys.push({ key: raw });
    }
  }
  return keys;
}

export function literalIn(text) {
  const at = text.search(/[`"]/);
  return at < 0 ? null : readLiteral(text, at);
}

export function parseCell(line) {
  const head = /^- `([A-Z][A-Z0-9]*\.[^`\s]+)` /.exec(line);
  if (!head) return null;
  const id = head[1];
  let rest = line.slice(head[0].length);
  const source = readPieces(rest, 0);
  if (!source) return { id, prose: rest };
  const sourceText = source.value;
  rest = rest.slice(source.end).replace(/^,?\s*/, "");
  const otherAt = rest.indexOf("; B → ");
  const arrow = rest.lastIndexOf(" → ", otherAt < 0 ? rest.length : otherAt);
  const keyText = arrow < 0 ? rest : rest.slice(0, arrow);
  let after = arrow < 0 ? "" : rest.slice(arrow + 3);
  const dot = after.indexOf(" · ");
  const notes = dot < 0 ? "" : after.slice(dot + 3);
  const both = dot < 0 ? after : after.slice(0, dot);
  const split = both.indexOf("; B → ");
  const main = split < 0 ? both : both.slice(0, split);
  const other = split < 0 ? null : readPieces(both.slice(split + 6), 0);
  let expectText = null;
  let expectKind = "bytes";
  let position = null;
  if (main.startsWith("same")) {
    expectText = sourceText;
    expectKind = "same";
  } else if (main.startsWith("at ")) {
    expectKind = "position";
    position = { at: readLiteral(main, 3).value };
  } else if (main.startsWith("on ")) {
    expectKind = "position";
    position = { on: readLiteral(main, 3).value };
  } else if (/^(later in the block|earlier in the block|later in the file)/.test(main)) {
    expectKind = "position";
    position = { move: /^(later in the block|earlier in the block|later in the file)/.exec(main)[1] };
  } else {
    const expect = readPieces(main, 0);
    if (expect) expectText = expect.value;
    else expectKind = "prose";
  }
  const routes = /\broutes? ((?:`[^`]+`(?:, |,? and )?)+)/.exec(notes);
  return {
    id,
    line,
    source: marked(sourceText),
    keys: splitKeys(keyText),
    expect: expectText == null ? null : marked(expectText),
    expectKind,
    position,
    other: other ? marked(other.value) : null,
    labels: [...notes.matchAll(/B (no longer )?sees the name (\S+) on (.+?)(?= \[|$)/g)].map((m) => ({ shown: !m[1], name: m[2], text: m[3] })),
    flashes: [...notes.matchAll(/A sees the name (\S+) flash on (.+?)(?= \[|$)/g)].map((m) => ({ name: m[1], text: m[2] })),
    notes,
    routes: routes ? [...routes[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]) : [],
    thenBoundary: /then the boundary/.test(notes),
    tags: [...line.matchAll(/\[(U|D\d+)\]/g)].map((m) => m[1]),
  };
}

// VIEWMARK_PLAN_PORT names the hub that holds the plan when it is not on the default port.
export function loadCells(prefix) {
  const port = process.env.VIEWMARK_PLAN_PORT ? ["--port", process.env.VIEWMARK_PLAN_PORT] : [];
  const shown = spawnSync(process.execPath, [CLI, ...port, "--user", "qa-bot", "--repo", PLAN.repo, "show", PLAN.path], { encoding: "utf8" });
  if (shown.status !== 0) throw new Error(`cannot read ${PLAN.path} from the ${PLAN.repo} hub repo: ${shown.stderr.trim()}`);
  return shown.stdout.split("\n").map(parseCell).filter((cell) => cell && cell.id.startsWith(prefix));
}
