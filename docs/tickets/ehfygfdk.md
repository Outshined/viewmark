title: With vim keys on, undo in Insert follows Obsidian's vim mode
state: closed
type: enhancement
priority: medium
parent:
depends:
reporter: claude
created: 2026-10-16T14:12:55.186Z

With vim keys on, an Insert session, from entering Insert until Escape, is one undo step on the page, even across an arrow key: `i`, `xx`, ↓, `yy`, Escape, then one `u` takes back both `xx` and `yy`. In stock vim 9.2 the arrow ends the undo step, so one `u` takes back only `yy`. The owner decided on c16 in `editing.md` on 2026-10-16 that undo here follows Obsidian's vim mode, if that can be built (R109).

What QA found about Obsidian's vim mode, from its source on 2026-10-16. Obsidian's editor is CodeMirror 6 with the `@replit/codemirror-vim` package. That package leaves undo grouping to CodeMirror's history. In that history, a change joins the last undo step only if it comes within 500 ms of it and touches the text that step changed, and a caret move, such as an arrow key, ends the step. The exception is a change tagged `input.type.compose`, which always joins the step before it. The vim package tags some of its changes that way. The source does not show which keys typed in Insert get that tag, so it does not settle what one `u` takes back after `i`, `xx`, ↓, `yy`, Escape.

## Acceptance
{c1}QA writes the criteria once Obsidian's behavior for the keys above is known.{/c1} QA cannot run Obsidian here. The open question is on its comment.

The owner answered on 2026-10-16: in Obsidian, one `u` undoes one operation. QA's reading, which the owner can correct: an arrow ends an operation, as it ends an undo step in Obsidian's editor history.
- With vim keys on, `i`, `xx`, ↓, `yy`, Escape, then one `u` takes back only `yy`. A second `u` takes back `xx`. Ctrl-R puts them back one at a time, `xx` first.
- In Insert with no arrow, the session from `i` to Escape stays one undo step, as R109 says.
- With vim keys off, undo is unchanged (R92).
- In Firefox.

QA builds a browser test named for this ticket when it lands.

```comment c1 resolved
:: 0
@2026-10-16T14:12:55.358Z claude
For the owner: in Obsidian with vim mode on, after `i`, `xx`, ↓, `yy`, Escape, what does one `u` take back: both `xx` and `yy`, or only `yy`?

```
