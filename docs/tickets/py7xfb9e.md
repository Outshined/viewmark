title: Repeat the last vim change with .
state: closed
type: enhancement
priority: medium
parent:
depends:
reporter: Grok
created: 2026-10-22T16:15:44.967Z

`.` in Normal repeats the last change. The page remembers that change for the life of the page and plays it again at the caret where `.` is pressed. This replaces the sentence "`.` does not repeat a change" in `docs/editing.md`, the README, and R115. `test/vim-docs.test.js` asserts that sentence and changes with it. Today `test/vim.test.js` VX.6 consumes `.` and writes nothing.

## What is remembered
A change is a vim command that alters the document. The remembered change is the command, played with the motions this page already has, at the caret where `.` is pressed. It is not a second copy of those motions.

These commands are changes: `d`, `c`, `>`, `<`, `gu`, `gU`, `g~`, and the doubles `dd` and `cc`; `D`, `C`, `x`, `X`, `s`, `S`; `J` and `gJ`; `r` and `~`; `p`, `P`, `]p`, and `[p`; and an insert entered by `i`, `a`, `A`, `I`, `gI`, `o`, or `O`, including the keys typed until Escape. `cw` is one change: the operator, the motion, and the inserted text. A count typed before the command is part of the change.

A motion alone is not a change, and it leaves the remembered change as it was. So do a yank (`y`, `yy`, `Y`), a search (`/`, `?`, `n`, `N`, `*`, `#`, `gn`, `gN`), a scroll (`zz`, `zt`, `zb`), undo, redo, and a colon command (`:s`, `:d`, `:j`, and the rest of that line). `gc` and the keys that act on a current comment thread are not changes. `.` does not reply, resolve, or delete a thread. Clipboard `Ctrl-V` is not a change. There are no macros and no marks, and `.` does not add them.

A command the hub refuses does not become the remembered change. Undo does not clear it. `.` does not replace it with itself, so a second `.` plays the same change.

## Count
With no count, `.` uses the count stored on the change. A count typed before `.` replaces that stored count, and the next `.` uses the new one. Counts still stop at 10000. `3x` then `.` deletes one character three times over again. `3x` then `2.` deletes two characters, and another `.` deletes two.

`o` and `O` repeat as separate lines. `3oab` then Escape opens three lines, each ending in `ab`. `.` does that again. The inserted text is not piled onto one line.

On a change that was an operator plus an insert, the count applies to the operator and the inserted text is written once. `2cwXX` then Escape changes two words and writes `XX` once. `.` does that again.

## Insert
The insert log is the keys of that insert session, in order: typed text, Backspace, Delete, `Ctrl-W`, `Ctrl-U`, and the arrow keys. Arrow keys in Insert still move one drawn row and stay in Insert. `.` plays that log back. `iab` then Backspace then `c` then Escape, played again, inserts `ac`.

`i`, `a`, `A`, `I`, and `gI` play the log once for each count, at the place that command inserts. `3iab` then Escape inserts `ababab`. `.` inserts `ababab` again. `2.` inserts `abab`.

`o` and `O` interlace. Each count opens one line and then plays the log on that line.

An empty insert is still a change. `i` then Escape remembers an empty insert, and `.` inserts nothing.

`Ctrl-O` runs one Normal command and returns to Insert, as it does now. When that command is a change, it is an entry in the insert log, between the text before it and the text after it.

## Visual
A change made in Visual or Visual Line remembers the size of that highlight, and `.` applies the same operator to the same size at the caret. Character Visual on one line uses that many characters. Character Visual across lines uses that many lines and the same number of characters on the last line. Visual Line uses that many vim lines. A count typed before that `.` is ignored and does not replace the stored count. There is no visual-block mode.

## Where the command is recognized
`.` repeats only in Normal, and only when it is the command itself. In Insert it is the character `.`. In Visual and Visual Line it changes nothing and leaves the highlight. After `f`, `F`, `t`, `T`, or `r`, the next `.` is the character argument, so `f.` finds a period. When an operator is waiting, `.` is not a motion: the operator is cleared, the text stays, and the remembered change is not played.

A motion that finds nothing, such as `.` after `dfx` when no `x` follows the caret, changes nothing. The caret stays. The remembered change stays.

With no remembered change, `.` is consumed, the text stays, and the caret stays.

Vim keys off, `.` is a typed period. Turning vim keys off clears the remembered change. Turning them on starts with none.

## Where Obsidian and vim differ
Obsidian uses the CodeMirror vim keymap. Its `.` is `repeatLastEdit`: it stores the last operator or action and the insert log, then plays them at the cursor. A count on `.` sets `repeatOverride` and replaces the stored count. `o` and `O` interlace the new line with the insert log. A count on an operator-plus-insert applies to the operator, and the insert log plays once. That is the same model as vim's `.`.

Two edges differ. Stock vim is the rule already recorded for those edges.

In vim, the insert log is the whole session. A caret move in Insert is part of the log, and `.` moves and then inserts. In Obsidian, a caret move that is not itself an edit marks the log to reset, so the next typed character drops the earlier text and `.` repeats only what was typed after the move.

In vim, a yank is not a change unless `cpoptions` contains `y`, which the default does not. `dd` then `yy` then `.` deletes a line. In Obsidian every operator is recorded, yank included, so `dd` then `yy` then `.` yanks again.

This design follows vim on both edges. A repeat plays the whole insert log, arrows included. A yank does not become the remembered change.

## Memory and the hub
The remembered change is page memory, with the search pattern and the unnamed register. It is not stored in the document and it is not sent to the hub. Another session's edit does not change it. Switching documents keeps it. A reload starts with none.

`.` produces the same effects the original command produces. The hub sees ordinary splices. A span another person holds is refused, the text stays, that person's name flashes, and the remembered change stays. `p` and `P` put the unnamed register as it is when `.` is pressed, not a frozen copy of the earlier put. `]p` and `[p` reindent as one edit, and `.` does that again.

The caret after `.` is the caret the same command would leave if it were typed again at that spot.

## Undo
One `.` is one undo step, the same grouping as the original change. A repeated `x` is one step. A repeated insert is one step. A repeated `cw` is one step, covering the cut and the inserted text. `u` after `.` restores the bytes and the caret from before that `.`.

## Acceptance
- `ab‸c` then `x` leaves `ab` with the caret where `x` leaves it. Moving onto another character and pressing `.` deletes that character. `u` restores only that second delete.
- `‸x` then `iab` then Escape inserts `ab`. `.` inserts `ab` again. `2.` inserts `abab`.
- `iab` then Backspace then `c` then Escape, then `.`, inserts `ac`.
- `3oab` then Escape opens three lines. `.` opens three more. `2.` opens two.
- `2cw` with text typed before Escape, then `.` on a later word, changes two words and writes that text once.
- `3dd` then `.` deletes three vim lines. `2.` deletes two, and the following `.` deletes two.
- `j`, `yy`, `/`, and `:s/old/new/` leave the remembered change untouched. After `x`, each of those, then `.`, deletes one character.
- In Insert, `.` inserts a period. In Visual, `.` leaves the highlight and the text.
- `f.` finds a period and does not repeat a change.
- A Visual Line delete of two vim lines, then `.`, deletes two vim lines from the caret. A count before that `.` changes nothing about the size.
- `.` after `dfx`, with no `x` to the right, changes nothing.
- With no remembered change, `.` changes nothing.
- A refused span changes nothing and keeps the remembered change.
- Vim keys off, `.` inserts a period. Turning vim keys off and on clears the remembered change.
- The sentence in `docs/editing.md`, the README, and R115 describes this repeat. VX.6 no longer expects `.` to match nothing.
- A Firefox test covers `.` after `x`, after an insert, and after `dd` on a rendered paragraph, and that test passes in Firefox before this ticket is closed.
