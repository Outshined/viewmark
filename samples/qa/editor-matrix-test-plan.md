# QA plan: editing matrix in a live browser
Contract: Every key, click, and clipboard action a person uses on the page, applied to every markdown construct that changes layout, in Chromium and in Firefox, against a running hub, with real input events. The rules below are what the cells check. Each rule names its source: `[A]` AGENTS.md, README.md, or `qa/lock-spans-test-plan.md`; `[T name]` a test in `test/editor.test.js` that asserts it; `[U]` decided by the owner; `[D#]` a default listed under Decisions. A default is approved unless it says it is not, or says which part is QA's reading. A rule with no tag is restated from a tagged rule next to it. Tests are cited by name because line numbers drift.

`editing.md` states the same rules for the owner, under the same numbers. A change to a rule here is made there too, and a change there is made here.

Display.
- R1 `[A]` Only the block holding the caret's focus is raw. A raw block shows its source characters, with two exceptions:
  - Hard-break markers (two or more trailing spaces, or a trailing `\`) are hidden in both modes `[T wrapped paragraph hard break hides its marker]`.
  - The `>` of a quote paragraph that spans several source lines is hidden even when raw `[T quoted paragraph is one block]`.
  
  A selection across blocks makes only the focus's block raw.
- R2 `[D14]` A table or a diagram opens as source when its start ≤ caret ≤ its end. The end is the offset of the newline after its last line, or the end of the file when that line has no newline, so a caret at the end of the last row or of the closing fence line is inside.
- R3 `[D2]` A file that ends with a newline has an empty line after it. While the caret is on that line, the page draws it as an empty line, and the caret is drawn there.
- R4 `[D21]` Three points of the dialect that `qa/lock-spans-test-plan.md` leaves open, as the page draws them:
  - A line that holds only an image is its own block. The lines above and below it do not join it.
  - A table's body rows are the lines after its delimiter that start with `|`. Any other line ends the table, so a prose line right after a table is a paragraph, not a row.
  - A rule is exactly `---`, `***`, or `___`. Any other character on the line makes it prose.
- R5 `[D18]` A file that uses `\r\n` is drawn and edited as if each `\r\n` were one newline. Every newline the page writes into that file is `\r\n`, and no edit leaves a lone `\r`.
- R6 `[U]` Markdown syntax is not visible, and no space is held for it, until its block is the current one. A list item's bullet or number is not hidden: the closed item draws it in the gutter left of the text. When the item turns raw, its source marker is drawn in that same gutter, so the item's text does not move, at any nesting level. `browser/list-marker.browser.js` checks this; the cells do not measure horizontal position.
- R7 `[U]` In formatted text, the space between two paragraphs is padding, not an empty line. The blank line stays in the raw markdown. The caret moves from line to line, and the last line of a paragraph is about half a line taller than the line above it. That is the visual break. Line behaviors stay as they are. There is no line between two paragraphs, so the caret cannot stop there: it goes from the last line of one paragraph to the first line of the next. The caret can stop on any line that is not only markdown structure the renderer consumes `[U]`. So it can stop on a line of only spaces or a tab between two paragraphs, at the line's start (D16). It cannot stop on the blank line between a fence, a table, a diagram, an image, or a rule and the block after it, which is space, as the blank between two paragraphs is `[U]`.

Typing.
- R10 `[T T-insert-undo-redo]` A typed character goes in at the caret, and the caret follows it. A selection is replaced by it `[T selection replace and ends]`.
- R11 `[D2]` The first character typed on the empty line after the final newline, when that line sits directly under a paragraph line, an item, or a quote, is written after a blank line, so it starts its own block (R24). The same holds on any empty line directly under a paragraph line, an item, or a quote, and at the start of a rule or a fence line directly under one: a character, or a paste that does not already start with a newline, writes one newline first. A paste that starts with a newline does not gain another. A continuation line of a paragraph, an item, or a quote stays in its block (R10). The implementer added this extension, and it is not approved. List items pasted on the empty line under a list join that list, with no newline first `[U]`: nothing in a list pasted into another list says it should break off as a new list, a person who wants a new list makes one, and the page does what surprises the person least. R99 still decides where the text is drawn.

Enter.
- R18 `[U]` Backspace does the same thing at a place, whether the caret moved around or not, and whatever made that place. It is not an undo of Enter. One Backspace does not take back Enter on an item, a quote line, or inside a paragraph. The markdown needs a blank line where the rendered text does not, so the page makes the changes the markdown needs, so that the rendered text makes sense to the person. So Backspace on the empty line under a paragraph removes that line and the blank line above it, and the caret goes to the end of the paragraph. When another block follows that empty line, the blank line above stays, so the two blocks stay apart: `one\n\n‸\ntwo\n` becomes `one‸\n\ntwo\n`, not the one paragraph `one\ntwo`. After Enter on an item or a quote line, Backspace removes one marker, as R32 does at that place. D34 gives the places.
- R19 `[T enter on a list item continues that item]` Where no rule below applies, Enter writes one newline at the caret, and then R24 applies.
- R20 `[T enter on a list item continues that item]` On a list item (bullet, ordered, nested, or quoted), Enter writes a newline and that item's marker. An ordered number goes up by one. Text after the caret moves to the new item.
  - This applies anywhere in the item's block, including a continuation line `[D4]`.
  - Later ordered items at the same level are renumbered to follow on `[D4]`.
  - A task item continues as an unchecked task item, `- [ ] ` `[D19]`.
- R21 `[U]` On a quote line, Enter writes a newline and `> `. Text after the caret moves to the new quote line. On a continuation line of a quote paragraph, the new line also starts with `> `.
- R22 `[U]` Enter on an empty item leaves the list:
  - A top-level empty item, or an empty task item, loses its marker.
  - A nested empty item is outdented one level instead.
  - An empty quoted item becomes the empty quote line `> `.
  - Enter on an empty quote line `> ` removes the `> `.
  
  R24 applies to the line that is left `[D1]`.
- R23 `[U]` With the caret inside a paragraph's text, not at its end, Enter splits the paragraph into two, with one blank line between them, and the caret starts the second. A soft newline at the split point becomes part of that blank line. This overrides `[T enter at the end of a line inserts a blank line below the caret]`.
- R24 `[D1]` Text typed on the line that Enter gives the caret is drawn as its own block. Where the dialect would join that line to the line above or below into one block, Enter writes a blank line between them. In formatted text that blank line is padding, not a line (R7), so the caret's line is drawn directly under the block above. `browser/paragraph-gap.browser.js` checks the drawing.
  - A paragraph line, an item, and a quote take the next line as continuation.
  - A paragraph line takes the line before it.
  - A heading, a rule, a fence, a table, and an image line (R4) do neither.
  
  `[T enter before a blank line keeps the caret line from joining]` asserts it.
- R25 `[D3]` Enter with the caret at the start of a block's text moves that block down one line and keeps the caret before the same character. So does Enter at column 0 of the block's first line. What is left above:
  - an item or a quote line leaves an empty item, or `> `, above it (R20 and R21 applied at the start);
  - a heading, a rule, or a paragraph leaves an empty line;
  - at column 0, before a marker, it is always an empty line.
- R26 `[U]` Shift+Enter writes a hard break inside the block, and the text after the caret starts a new visual line in the same block. The form is D28, which the owner approved on a condition: the markdown has to stay valid, and its rendering has to read sensibly.
- R27 `[D4]` In a fence body, Enter writes one newline and nothing else, even when the line looks like an item.
- R28 `[D4]` On a line that starts with `|`, Enter writes one newline, so a table can be typed row by row. A row typed on the new line joins the table.
- R29 `[D4]` Enter on a selection first deletes the selection, then acts as Enter at the caret that is left.

Backspace.
- R30 `[U]` `[T backspace at the visual start of a line joins it upward]` With the caret on an empty line, Backspace removes that line, and the caret is drawn at the end of the line above. At the start of the file it does nothing `[T collapsed caret removes a blank line and keeps a joining newline]`.
  - A line drawn empty counts as empty: one that holds only spaces, tabs, or a `\r`, or a line of spaces inside a paragraph that the dialect draws as an empty visual line `[D16]`.
  - The end of a line is before its hidden trailing markers `[D17]`.
- R31 `[T backspace at the visual start of a line joins it upward]` Otherwise Backspace deletes the one character before the caret. A soft newline, drawn as a space, is such a character `[T wrapped paragraph maps the joining space and edits at that newline]`.
- R32 `[D5]` Backspace directly after a list, task, or quote marker, with nothing between the marker and the caret, removes one marker:
  - a task item's `[ ] ` or `[x] ` goes first, then its list marker `[D19]`;
  - a top-level item's marker;
  - a quote line's `> `;
  - a quoted item's list marker, leaving `> `;
  - a nested item is not unmarked: it is outdented one level, as Shift+Tab does.
- R33 `[U]` After a hard break, Backspace deletes the newline and the hidden trailing spaces or backslash with it.
- R34 `[T T-backspace-atom]` `[D14]` A selection that covers exactly a table, a diagram, or an image deletes it whole. With R2 as `[D14]` states it, a caret at a table's end is inside the open table, so Backspace there deletes one source character. On a raw image line, Backspace deletes one source character `[T T-raw-image-backspace]`. With a picture line selected, Backspace and Delete each remove that line. The picture file stays while a session has the document open. A file that no image line names is removed when the last session closes the document.
- R35 `[T selection replace and ends]` A selection is deleted.
- R36 `[T deleting an empty comment interior drops the span and the thread]` A delete that empties a comment's text removes the comment's opening and closing markers and its thread.
- R37 `[D6]` A comment marker is never cut. A Backspace, Delete, or word delete that would remove part of a comment marker, without emptying the comment, acts on the character beyond the marker instead. The caret stays on the same side of the marker.
- R38 `[D6]` The caret never rests inside a comment marker. ← and → step over a whole marker in one press. A click inside a drawn marker lands on the marker's nearer edge.
- R39 `[D6]` A selection delete that covers one marker of a comment and not the other keeps the comment around what is left of its text. The covered marker moves to the edge of the deletion, and the caret is drawn outside the comment.

Delete.
- R40 `[U]` With the caret on an empty line, Delete removes that line, and the caret stays before the next line's text. Where exactly the caret stays is D31. D16 and D17 apply as in R30. Delete pulls the previous line up, and the page then copes with whatever that does to the markdown below it. D31 gives QA's reading, with examples.
- R41 `[T T-delete]` Otherwise Delete removes the one character after the caret. At the end of the file it does nothing, even on the empty line after the final newline.
- R42 `[D15]` `[D35]` When only hidden hard-break markers lie between the caret and the newline, Delete removes that newline and the markers. This is the mirror of R33.

Word delete.
- R50 `[D7]` Ctrl+Backspace deletes back to the start of a group:
  - first any spaces before the caret, then the run before them;
  - a run is either word characters (letters, digits, `_`) or other non-space characters;
  - a soft newline counts as a space;
  - on an empty line it is Backspace.
  
  Ctrl+Delete mirrors it forward. R36 to R39 apply. A rendered atom inside the range is deleted whole.

Tab.
- R60 `[U]` `[D8]` On a list item, Tab writes one `\t` at the start of the item's line, and the caret keeps its place in the text.
  - Shift+Tab removes one leading `\t`, or else up to four leading spaces. On a top-level item, Shift+Tab does nothing.
  - An ordered item that becomes the first item of a new level is renumbered `1` `[D4]`.
  - An ordered item that moves to a level where an item comes before it takes the next number after that item.
  - With a selection over several items, each item is indented or outdented, and the selection keeps covering the same characters.
  - On a quoted item, Tab and Shift+Tab do nothing.
- R61 `[T T-tab-key]` Elsewhere, including a fence body, Tab writes `\t` at the caret and replaces a selection.
- R62 `[D8]` Elsewhere, Shift+Tab does nothing, and the focus stays in the editor.

Moving.
- R70 `[T shift-arrow keeps the anchor and an unshifted arrow collapses]` ← and → move one character through the source as it is drawn. On the raw block, that includes its markers.
  - Hidden source characters (R1) are skipped, so an arrow never lands between them `[D17]`.
  - Shift extends the selection from the anchor.
  - An unshifted arrow key with a selection, including ↑ and ↓, moves from the focus.
  - Alt with an arrow still moves one character. Ctrl+← and Ctrl+→ move by word `[U]`; where they stop is D29.
- R71 `[D9]` → at the end of a line lands on the first boundary drawn on the next line. That boundary is after the next line's marker, because the marker is hidden until the caret arrives. → onto a rule lands at the start of the rule's line, and the rule turns raw. ← at the start of a line lands at the end of the line above. The difference between the two directions is intended: a caret moving backward meets the raw block's drawn marker first.
- R72 `[T T-snap-rendered]` `[D14]` Atoms:
  - An arrow never stops inside a closed image.
  - Entering a closed table, or entering a diagram with ← or →, lands at its start going forward and at its end going backward, and it opens.
  - ↑ and ↓ jump over a diagram.
- R73 `[D10]` ↑ and ↓ move to the visual line above or below. They land on the boundary nearest the x where this run of vertical moves began, measured on the lines as drawn just before each press. Repeated presses keep that x.
  - On the first line, ↑ goes to the start of the file.
  - On the last line, ↓ goes to the end of the file (R3).
- R74 `[D11]` Home goes to the start of the visual line's text, after a hidden or drawn marker. A second Home goes to the start of the visual line. End goes to the end of the visual line, before hidden trailing markers `[D17]`. Ctrl+Home and Ctrl+End are the browser's own: the first and last boundary drawn in the document. Shift with any of them extends the selection.
  - `[U]` End works on visual lines: it goes to the end of the visual line the caret is on. End puts the caret after the line's last character, a space included, in raw and in rendered text. A character typed there goes in at the caret, like any typed character, and wraps as normal text does.
  - So where a visual line wraps at a space, End goes after that space, and the caret is drawn at the end of the line it was on. A letter typed there goes in after the space, and wraps with the next word to the start of the next line. Where a line breaks inside a word, as a long URL does, End goes after the last character of that full line, and a letter typed there starts the next line. Raw text is the same.
  - QA's reading, not the owner's: the hidden trailing markers of D17 are not drawn on the line, so End still stops before them.
  - Where a visual line wraps at a space, Home on the next line goes after that space, and the caret is drawn at the start of that line `[D27]`.
- R75 `[D11]` Escape changes nothing and keeps the focus. PageUp and PageDown are the browser's own. The next edit acts where they leave the caret.

Clicking.
- R80 `[T moving inside a paragraph keeps one held span]` A click puts the caret at the boundary under the pointer. The left half of a glyph means before it, and the right half means after it. Where a hidden marker separates two glyphs:
  - the left half of the glyph after the marker maps to after the marker;
  - the right half of the glyph before the marker maps to before the marker.
  
  The clicked block turns raw, and the caret is drawn before the same character, which may have moved. A click in the margin left of a line, or right of its end, lands at that line's start or end.
- R81 `[T fence clicks open source]` Clicks on atoms:
  - A click on a table cell puts the caret at the start of that cell's text, and the table opens.
  - A click on the table outside a cell puts the caret at the table's start.
  - A click on a picture that is the whole line selects that line, including the newline after it, and the picture stays drawn. A click on an inline image puts the caret at the image's start.
  - A click on a diagram puts it at the start of the diagram's body.
  - A click on a list bullet, or on a quote bar, puts it at the start of that line's text, after its marker `[D12]`.
- R82 `[D12]` A click on a rule puts the caret at the start of the rule's line.
- R83 `[D2]` A click below the last line puts the caret at the end of the file.
- R84 `[U]` `[D13]` A double-click selects the word under the pointer, without markdown markers.
  - A word is a word-like segment from `Intl.Segmenter` with `granularity: "word"`, as Chromium's own double-click uses. Any `*`, `_`, `~`, or backtick at either end is trimmed off.
  - On a run of two or more spaces it selects nothing, and leaves the caret there `[T detail 2 selects the word and detail 3 selects the block]`.
  - The word selected is the one under the pointer at the first press, even if the block turns raw and its text moves before the second press.
- R85 `[U]` A triple-click selects the block under the pointer, not one source line. Where the selection starts and ends is D32.
- R86 `[T detail 2 selects the word and detail 3 selects the block]` A drag selects from the press point to the release point, each mapped as in R80. Both ends map against the text as drawn when the button went down. No block turns raw until the release `[D12]`.
- R87 `[D22]` Shift+click extends the selection from the anchor to the clicked boundary.
- R88 `[D20]` A middle-click on Linux pastes the primary selection at the clicked boundary, as R91 pastes. Dragging selected text and dropping it moves the text: it is deleted where it was and inserted at the drop point, as one edit. Neither leaves drawn text that the bytes do not hold.

Selections, clipboard, history.
- R90 `[T selection replace and ends]` Typing replaces a selection. Backspace and Delete delete it. Enter follows R29, and Tab follows R60 and R61. Ctrl+A selects the whole file `[D11]`.
- R91 `[A]` Copy puts the selected source on the clipboard as plain text. Cut does the same, then deletes the selection. Paste inserts the clipboard's plain text at the caret, replacing a selection, and leaves the caret after it. Pasted `\r\n` becomes the file's newline (R5). A pasted or picked picture is stored beside the document. Inside a paragraph the paragraph stays whole and the image line follows that block after a blank line. On the blank line between two paragraphs, that blank line becomes the image line. The caret ends after the image line.
- R92 `[T T-insert-undo-redo]` `[T an insert renders only from the doc message]` `[U]` `[D33]` Undo and redo:
  - Ctrl+Z undoes one edit and restores the caret and selection from before it.
  - Ctrl+Shift+Z and Ctrl+Y redo it and restore the caret from after it.
  - An edit after an undo clears the redo.
  - With nothing to undo, Ctrl+Z changes nothing.
  - A run of typed characters is one undo step, as D33 sets out.
- R93 Composed text is written once, at the caret, when the composition ends. Nothing is written while it is composing, including by a Backspace pressed during composition.
- R94 `[A]` An edit by another user moves the caret only when the edit lands before it. The caret keeps its place in the text.
- R95 `[U]` A redraw that changes no bytes never moves the caret or the selection. That covers a redraw caused by another client opening, reading, or locking the file.
- R96 `[T locks name another user and a rejected lock does not take the caret]` A block another session holds shows that user's name. A click into it does not take the caret there, and the caret stays where it was. When that session's caret leaves the block, the name goes, and the block can be entered. Two browser tabs are two sessions, even when the same user is in both: a block one tab holds is refused to the other, which shows that user's name on it `[U]`. `browser/two-tabs.browser.js` tests this, because the cells' second session is always a different user.
- R97 `[A]` An edit from another client that touches a span this session holds is refused with 409. The bytes and this session's caret do not change.
- R98 `[D25]` Undo and redo act only on this session's own edits. Edits by other sessions and by agents stay, and the caret is restored to its place in the text as it is now.
- R99 `[U]` Text appears where the caret is when keys are pressed: a typed character is drawn where the caret was drawn just before the key. It is a rule for the whole page. I12 checks it after every cell. The character then wraps as normal text does: where the caret is drawn at the end of a line that wraps, the character goes in at the caret and can start the next line (R74). A picture pasted inside a block is drawn after that block, and that block is not split. That paste is the exception.

Comments.
- R100 `[D30]` Delete on a comment's card removes its fence and both of its markers in one edit. The text between the markers stays. The caret keeps its place in the text, and the focus stays in the editor, so Ctrl+Z right after brings the thread back.
- R101 `[D30]` No edit leaves a comment broken: each id opens once, closes once after it, and has one fence, and two comments never cross. That holds for typing, paste, drop, cut, and drag. I13 checks it after every cell.
- R102 `[D20]` `[D30]` Dragging a selection that holds both markers of a comment moves the comment with its text, as R88 moves any text. A paste or a drop never writes a marker that is already in the file.
- R103 `[U]` A comment added over a selection that starts at or before a line's markdown marker, such as `- `, `> `, or `# `, opens after that marker, so the block keeps its kind.
- R104 `[A]` The CLI cannot delete a thread whose markers sit in a block another session holds. That is 409 and names the holder. Once the block is free, the thread's author can delete it, and the page's caret keeps its place.
- R105 `[U]` While the pointer is over a comment's highlight, each end of it is drawn as a rounded handle, in rendered and in raw text. Dragging a handle moves that end of the comment. In the raw block the markers are drawn as these handles. In the raw block the end marker adds no space between the highlight's last character and the character after it. Whether the start marker may add space before the highlight is an open question on ticket `arh58dxz`.
- R108 `[U]` The add-comment button takes the primary mouse button only. Its top edge is a half line under the lowest edge of the selection highlight, and across, it sits at about the last selected character. There it covers part of the text under the highlight's last line, near that character, and a press there lands on the button. That is the one place where the button covers text: it covers neither the line above the selection, nor the selection's own line, where the third press of a triple-click can land. It stays off comment cards (not approved). It comes after any selection that can take a comment, however the selection was made (QA's reading, not approved). When its place is not inside the window, the page makes room for the button there. The page extends so that the person can scroll to the button, and it need not scroll there by itself. Only if there is really no room, and the page cannot be extended, does the button go above the highlight. Cells `CK.ac.1`, `CK.ac.2`, `T3.ac.1`, and `CK.mid.1` test it. `browser/comments.browser.js` tests the placement in the cases whose names cite `mar9nkqb`, with QA's tolerances in its comments.

The comment rules are tested by `browser/comments.browser.js`, outside the cells, because they use the comment cards and multi-step drags.

Files.
- R106 `[U]` A file a session has open cannot be deleted. The CLI's `delete` and the page's Delete are refused with 409 and name that session's user. A rename or a move updates every session that has the file open: its address, its files list, and its title. A closed tab, or a page that is left, lets go of its file and its blocks at once. A rename or a move does not change any session's caret (D37). `browser/file-life.browser.js` tests this, outside the cells.

Raw view.
- R107 `[U]` The page opens rendered. Raw is a selection for the document that is open, and nothing is stored. Another file, a reload, and a new tab start rendered. Raw draws every byte and does not interpret markdown, so a code fence has no syntax colors, and a click or a typed character inside a comment marker stays on that byte. The hub stores that character the same way the CLI's edit does. A rendered insert that cuts a marker is still refused. Comment cards stay up. The eye button stays fixed at the top right of the visible pane. R38 holds in rendered mode, not in the raw view. `browser/raw-view.browser.js` tests this, outside the cells.

Vim keys.
- R109 With Vim keys off, the editor behaves as it does now: the rules above hold as written. With Vim keys on, the keys in Normal, Visual, and Visual Line do what vim does, as R110 to R122 say, where that differs from the rules above. Stock vim is the default unless the owner says otherwise. Where Obsidian's vim mode differs from stock vim, the owner decides `[U]`. Shift+arrow in Normal moves the caret and leaves it collapsed, where R70 extends the selection. Shift+→ and Shift+← move by a word, as `w` and `b` do in stock vim `[U]`. Shift+↓ and Shift+↑ page down and up, as Ctrl-F and Ctrl-B do in stock vim `[U]`. An Insert session, from entering Insert until Escape, is one undo, including a pause, Backspace, and Enter, so the one-second cutoff of R92 does not apply during it. The owner prefers the undo of Obsidian's vim mode here, where one `u` undoes one operation `[U]`. QA's reading, not the owner's: an arrow ends an operation, so after `i`, `xx`, ↓, `yy`, Escape, one `u` takes back only `yy`.
  - Source, as QA found it on 2026-10-16. The implementer's notes c7.2, c8.2, and c22.2 on 7vdep2z4 say the owner decided this rule. No note from the owner records it. The owner's own notes there are c2.0, c3.0, c4.0, and c25.1, and c25.1 asks that Shift+Tab do what vim does. The owner decided on 2026-10-16 that stock vim is the default unless the owner says otherwise. Stock vim 9.2, with no vimrc, differs from it twice: Shift+→ and Shift+← in Normal move by a word, and an arrow in Insert ends the undo step. The owner answered both on 2026-10-16, on c15 and c16 in `editing.md`, as the rule now says.
- R110 `[A]` The document menu item Vim keys is off until it is checked. The browser remembers the choice for every document it opens, and stores it as `viewmark.vim`. The hub does not store it. A status beside that menu shows `N` for normal, `I` for insert, `V` for character visual, and `VL` for line visual. A count or an operator that is still waiting shows there instead of the letter. Normal and both visual modes draw a block caret. Insert keeps the thin caret.
- R111 `[A]` Escape, or Ctrl-[, leaves insert or visual and returns to normal. `i` inserts at the caret, `a` after the next character, `I` at the first non-blank of the vim line, `A` at the end of that line, and `gI` at the first column. `o` opens a line below and `O` a line above, then insert. In visual, `o` and `O` swap the ends of the highlight. `v` and `V` enter or leave those two visual modes, and each switches to the other. In insert, Ctrl-W or Command-W deletes the word before the caret, Ctrl-U deletes back to the start of the source line, Ctrl-T adds a leading tab, Ctrl-D removes one, and Ctrl-O runs one normal command and then returns to insert. Arrow keys in insert move and stay in insert. ↑ and ↓ in insert move one drawn row, as they do with vim keys off `[U]`. In the other modes that W chord is taken and does not change the text, so it does not close the browser tab.
- R112 `[A]` A vim line in the formatted view is a rendered block. `j` and `k` move by that block, not by a source line and not by a wrapped row. A code fence is the exception: inside it, `j` and `k` move one line of code, and `V` selects lines of code, as in stock vim `[U]` (g92jk6em). A paragraph is one line when it wraps, and a single newline inside it stays on that line. The blank between paragraphs is not a line, so `j` does not land there. `gj` and `gk` move by display row. `g0`, `g^`, and `g$` are that row's start, first non-blank, and end. In the raw view a vim line is one source line, and those `g` motions are `j`, `k`, `0`, `^`, and `$`. `w` can leave the line. `dw` and `cw` stop at the end of it. A linewise delete in the formatted view also takes the blank under the block. A linewise change leaves that blank and opens one empty line. `j` does not step onto the empty row after a final newline. `k` from that row returns to the last block.
- R113 `[A]` Comment markers and the tail of a hard break are skipped. The caret does not sit inside them. `r` and `~` change ordinary text on the vim line. A count that would include a line break or a comment marker changes nothing. Deleting one side of a comment keeps the comment on the text that remains. Deleting both sides takes the comment with the text.
- R114 `[A]` `gc` comments the highlight. In visual or visual line, `gc` on a highlight that is not already a comment adds one and opens an empty note. The mode stays visual or visual line until Ctrl-Enter or Command-Enter saves the note and returns to normal. A refused range, such as a highlight that is only a list marker, writes nothing and leaves the highlight. `gc` with the caret on an existing comment makes that thread current, and visual or visual line `gc` does the same when the highlight is already inside that comment. Then `r` replies, `R` resolves or reopens for the author of the first note, `X` deletes for that author, `Y` copies the link, and `i` opens the earliest note this session authored. Escape deselects the thread, discards an unsaved reply or revision, and normal navigation resumes. Normal `gc` off a comment does nothing. `c` is still change. In visual line, `R` still changes the highlighted lines. While a thread is current, `R` resolves or reopens for the first note's author instead. Elsewhere `R` is not replace mode.
- R115 `[A]` `y` and `p` use one unnamed register, which is not the clipboard. `"` does not select another register. `p` puts after the caret and `P` before it. A linewise register opens its own line. `]p` and `[p` put that line and then reindent it, as one edit. Ctrl-C copies a visual selection to the clipboard and stays visual. Ctrl-X cuts it and returns to normal. Ctrl-V pastes the clipboard. That paste works in normal, in visual, and in insert. There is no visual-block mode. `u` undoes in normal, and Ctrl-R redoes. Ctrl-Z undoes as well, including in visual, and Ctrl-Y and Ctrl-Shift-Z redo. In normal, `U` changes nothing. In visual, `u` and `U` change case. `.` in normal repeats the last change at the caret, and a count typed before `.` replaces the count stored on that change. There are no macros and no marks. Ctrl-A selects the whole file as a line visual selection.
- R116 `[A]` Search text is literal. `/` and `?` remember earlier patterns for the life of the page. That history is page memory. It is not stored in the document and it is not sent to the hub. Up-arrow recalls the previous pattern. Down-arrow walks back to the draft. Matches are painted while the pattern is typed and after Enter. `:noh` clears that paint and leaves the pattern, so `n` still repeats. `/` searches forward and `?` backward. Enter runs the line and Escape closes it. `n` and `N` repeat the search. `*` and `#` search the word under the caret as a whole word, and `g*` and `g#` search it without that limit. `gn` and `gN` select the next or previous hit. A search wraps once. No hit leaves the caret where it is.
- R117 `[A]` `w` and `W` are the same motion, and so are `b` and `B`, `e` and `E`, and `ge` and `gE`. A word runs until whitespace, so the punctuation it touches stays on it. Counts are typed before the command and stop at 10000. The digit `0` starts a count only after another digit. Alone, `0` is the first column.
- R118 `[A]` Motions are `h` `l` `j` `k` and the arrow keys, `0` `^` `$` `|`, `gg` and `G` with a count for a vim line, `w` `b` `e` `ge`, `f` `F` `t` `T` then `;` and `,`, `%` on brackets, `{` and `}` by block, and `H` `M` `L` for the top, middle, and bottom of the rows on screen. `+`, `-`, and Enter move by line and land on the first non-blank. `_` does that on the counted line, where 1 is the current line. Ctrl-F and Ctrl-B move by the rows on screen, and Ctrl-D and Ctrl-U move by half of them. `zz`, `zt`, and `zb` put the caret's line at the center, the top, or the bottom. `z.`, `z-`, and `z` followed by Enter do that and also move to the first non-blank. Ctrl-N and Ctrl-P are `j` and `k`. Home is `0`, End is `$`, Page Up is Ctrl-B, and Page Down is Ctrl-F. Space is `l` and Shift-Space is `w`. Backspace is `h` and Shift-Backspace is `b`. Delete is `x`.
- R119 `[A]` Operators are `d`, `c`, `y`, `>`, `<`, `=`, `gu`, `gU`, and `g~`. Doubled, they act on the vim line, and a count is that many lines. `D` and `C` run through the end of the line. `x` and `X` delete characters and stay on the source line, stopping before its newline. `s` deletes those characters and enters insert. In visual, `s` changes the highlight. `S` changes whole vim lines and enters insert. In visual line, `R` and `S` change the highlighted lines. While a thread is current, `R` resolves or reopens for the first note's author instead. Elsewhere `R` is not replace mode. `Y` yanks the line. `J` joins with a space and `gJ` joins without one. `r` replaces the following characters with the next key, and Enter as that key writes one line break for the whole count. `~` toggles case. `>` and `<` are a list indent, not a shift of spaces. `>` writes one leading tab, and an ordered item that starts a new level is numbered 1. On a line that is not a list item, `>` writes a tab at the start and `<` removes one leading tab. `=` changes a list item to one level under the item above, or to the top level when there is no item above, and it leaves any other line as it is. On a list item, `<<` lands on the item text. Tab and Shift-Tab in normal and visual are `>` and `<` `[U]`, which differs from stock vim. In insert, Tab is the ordinary list indent, and Shift-Tab does what Tab does.
- R120 `[A]` Text objects follow an operator, or they extend a visual selection. They are a word (`iw`, `aw`), an inline code span (inner or around a backtick), a single or double quote that closes on the source line, a link label (`i[` and `a[`, or the same with `]`), and a block (`ip`, `ap`). `aw` takes the spaces after the word, or the spaces before it when none follow. `ip` stops before the block's own newline. `ap` also takes the blank lines after the block, or the blank lines before it when nothing follows.
- R121 `[A]` `:` opens a command line in normal. In visual it returns to normal and writes nothing. The names are `delete` (`d`), `join` (`j`), `yank` (`y`), `undo` (`u`), `redo` (`red`), and `substitute` (`s`). A shorter name works when it is a prefix of that word and at least as long as the short form. `%d` clears the document and yanks it as a line. Without `%`, delete, yank, and substitute use the source line, and join joins the way `J` does. `:s/old/new/` replaces the first literal `old` on that span. A final `g` replaces every match. `%s/old/new/g` covers the whole document. A slash inside a field is written `\/`. Any other range is refused, and an unknown command changes nothing.
- R122 `[A]` A vim edit is still an edit. A span another person holds is refused, the text stays, and that person's name flashes on the span.

The vim rules are tested by `browser/vim.browser.js`, `browser/vim-g-long.browser.js`, and `browser/vim-accept.browser.js` with its parts in `browser/vim-accept/`, outside the cells.

Setup: The cases run in Chromium, or in Firefox as described below, against a hub. Do not start the hub on port 8765, and do not touch `state/` or `docs/`.

- **Hub.** The harness starts the hub inside the test process with `start(0, STATE)`. That function is exported by `server.js`; it takes a port and a state directory and returns the listening server. `STATE` is a new temporary directory.
- **Repo.** The harness registers a repo named `qa` with `node cli.js --port PORT --user qa-bot repo register --name qa --description qa --path DIR`. `DIR` is a new temporary directory holding `box.svg`, an SVG 120 by 40 with no text.
- **Files.** Each cell creates its own file, named for the cell and the pass, with `node cli.js --port PORT --user qa-bot --repo qa create FILE --file SRC`. `SRC` holds the cell's source with the marks removed. No cell sees another cell's bytes.
- **Browser.** `/usr/bin/chromium` with these flags:
  - `--headless=new`, `--remote-debugging-port=0`;
  - `--user-data-dir=PROFILE`, where `PROFILE` is a new empty directory;
  - `--window-size=1920,1080`, `--force-device-scale-factor=1`;
  - `--font-render-hinting=none`, `--hide-scrollbars`;
  - `--no-first-run`, `--no-default-browser-check`, `--disable-extensions`, `--lang=en-US`.
- **Overrides.** `VIEWMARK_HEADED=1` drops `--headless=new` so a person can watch. `VIEWMARK_KEEP_PROFILE=1` keeps `PROFILE`.
- **Protocol.** The harness speaks the DevTools protocol over Node's built-in `WebSocket`. It enables `Emulation.setFocusEmulationEnabled` so the page keeps focus while headless. There are no packages.
- **Firefox.** `VIEWMARK_BROWSER=firefox` runs the same suites in Firefox. `VIEWMARK_FIREFOX` names its binary.
  - `browser/firefox.js` drives Firefox over WebDriver BiDi. It takes each DevTools call the harness and the tests make and does it in Firefox.
  - Firefox runs inside `cage` with its headless backend when cage is installed, so Firefox is a real window whose clipboard holds pictures, and the person's screen and clipboard are not touched. Without cage it runs with `--headless`, where the clipboard holds text only.
  - The profile sets a caret that does not blink, the clipboard API without a prompt, and one device pixel per CSS pixel. The viewport is 1920 by 1080.
  - BiDi has no drag interception, no input method composition, and no platform font report. A cell that needs one is BLOCKED as not automated, and a test that needs one is skipped in Firefox.
  - Firefox's screenshots leave out the caret, so where the caret is painted cannot be read. Where that decides the check, I3 and I12 are recorded as not checked: at a soft wrap, on a raw list line whose marker hangs, and with the selection between lines. Tests that only read the caret's paint are skipped.
  - A dropped file goes through the page's file picker instead, the same path for the bytes.
  - Firefox counts the presses of a double or triple click only within one input call. The harness sends each run of presses as one call, with the real gaps between them as pauses.
  - A tab is brought to the front before keys or the mouse go to it, as a person does.
  - BiDi cannot skip the cache on a reload, so a forced reload is the browser's own reload that skips the cache, as Ctrl+Shift+R runs it.
  - `browser/firefox-paste.browser.js` always uses Firefox, because it copies a picture with Firefox's own Copy Image menu item. It is skipped when there is neither cage nor `VIEWMARK_HEADED=1`.
- **Instrumentation.** `Page.addScriptToEvaluateOnNewDocument` installs a passive logger. It records `keydown`, `beforeinput` (with `inputType` and `getTargetRanges()`), and `selectionchange` with the DOM anchor and focus. It changes nothing.
- **Page.** The page loads `http://127.0.0.1:PORT/`. Once per run, the harness types `qa-bot` into the login field and presses Enter; a reload keeps that name, because the page stores it in `sessionStorage`. For each file it sets the location hash to `#qa/doc/FILE` (the page's deep-link form, `formatHash` in `src/editor.js`). It then waits until the `file` message for that path has arrived, `document.fonts.ready` has resolved, every `img` is `complete`, and every diagram has its SVG.
- **Module check.** The harness checks once that `import("/src/editor.js")` in the page returns the module the page runs: the URL it imports equals the `src` of the page's module script, resolved.
- **Clipboard preflight.** Once per run, in an `about:blank` tab with a textarea, the harness types `abc`, selects it, presses `Control+C`, clicks an empty textarea, and presses `Control+V`. When that pastes `abc`, a clipboard cell that gets no text is FAIL. When it does not, the clipboard cells are BLOCKED with `clipboard`.
- **What the harness relies on.** In headless Chromium:
  - these keys produce the browser's own `keydown` and `beforeinput`, with these `inputType`s:
    - Enter → `insertParagraph`
    - Shift+Enter → `insertLineBreak`
    - Backspace → `deleteContentBackward`
    - Delete → `deleteContentForward`
    - Ctrl+Backspace → `deleteWordBackward`
  - a double-click arrives as `click` with `detail` 1, then 2;
  - composition produces `compositionstart`, `insertCompositionText`, and `compositionend`;
  - `document.caretPositionFromPoint` exists;
  - a paste carries the text a page's `copy` handler set with `clipboardData.setData`, and the editor's handler does that.
- **Running.** The suite is `node --test browser/*.browser.js`, and `VIEWMARK_BROWSER=firefox node --test browser/*.browser.js` runs it in Firefox. Plain `node --test` does not run it.

Input:
- **Keys.** A key is `Input.dispatchKeyEvent` with `keyDown` carrying `text` when the key types text, otherwise `rawKeyDown`, then `keyUp`. Each event carries `key`, `code`, `windowsVirtualKeyCode`, and the modifier bits.
  - Enter's `text` is `"\r"`.
  - A printable ASCII character is typed this way, so the page sees its `keydown`.
  - `Input.insertText` is used only for text with no key: CJK, emoji, and the end of a composition.
  - The browser turns these into its own `keydown` and `beforeinput` events; the harness does not build DOM events.
- **Pointer.** Before each press, the harness sends `mouseMoved` to the point. Every point's y is the vertical center of the target glyph's rect, or of the target line's box.
  - A click is `mousePressed` then `mouseReleased` at one point, with `clickCount` 1.
  - A double-click is a click, then a press and release with `clickCount` 2 at the same point. A triple-click adds `clickCount` 3. The `DC` and `T3` cells each run twice: once with 30 ms between presses and once with 250 ms. Both must pass.
  - A drag presses at one point, moves in ten steps with `buttons: 1`, and releases at the other point.
  - `click below` checks with `DOM.getNodeForLocation` that the point is inside the editor root before pressing.
- **Composition.** Each `IM` cell lists its steps. Each step is one `Input.imeSetComposition` with the text so far. Then `Input.insertText` commits the final text.
- **No scripted selection.** The harness never sets the selection by script.
- **Clipboard.** The clipboard cells use real `Control+C`, `Control+X`, and `Control+V` keys, with the clipboard permission granted to the page.

Sync: After each key or pointer action, the harness waits for quiet. Quiet is two animation frames, then 100 ms with no websocket frame other than a ping or pong, then no `selectionchange` in the next animation frame. The harness never predicts whether a key edits. I5 compares the rev it observes. A cell that never reaches quiet within 5 seconds is FAIL with `no quiet`.

Reading the result:
- **Bytes** are the text the hub last sent the page for the file, in its `doc` or `file` message. At the end of the cell the harness also reads the hub with `node cli.js show` and checks that the two agree. It does not read the hub in the middle of a cell: a second client opening the file makes the hub send the page a `locks` message, and the page then redraws, which would disturb the caret being checked.
- **Caret** is `window.getSelection()` in the page, mapped through the page module's own `mapOffset`. I9 is the check that does not trust that mapping.
- **Drawn** is the rect of the live collapsed range, `getClientRects()[0]`, where a zero width is allowed. When the range has no rect, as in an empty block or before a lone `<br>`, drawn is the rect of the element at the selection point, with zero width at its left edge, and the result records `rect: fallback`. For a selection, drawn is the set of glyph rects inside the live range.
- **A boundary's drawn x** is the right edge of the glyph before it, or the left edge of the glyph after it when the boundary starts a visual line. An empty line's boundary is the left edge of that line's box.
- **Drawn at a boundary** means the caret's x is within 2 px of that boundary's x, and its vertical center falls inside that line's box.
- **Pixel check.** For `BG`, `EF`, and every cell whose caret sits on a wrap point or after a hidden marker, the harness also injects `* { caret-color: #f0f }` and takes two screenshots of the caret's line box, 600 ms apart. One of them must show a magenta column within 2 px of the boundary's x.
- **Raw** is the `md-raw` class on the block element.
- **Focus.** `document.hasFocus()` is true, and `document.activeElement` is the editor root or inside it.

Notation:
- **Fences.** Every list of cells sits inside a `text` fence, so nothing in a cell is read as markdown. Inside the fences, backticks and double quotes are the literal delimiters described next, not markdown.
- **Literals.** A source in backticks decodes only these escapes: `\n` is a newline, `\t` is a tab, and `\\` is one backslash. This matches `qa/lock-spans-test-plan.md`. A source in double quotes is a JSON string.
- **Comment thread.** `+ CM` appends this JSON string to the source, and to the expectation:

```text
"\n\n```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nNote.\n```\n"
```

- **Atoms at the top.** The page opens a file with the caret at offset 0. A fixture that begins with a table, a diagram, or an image line would open with that atom drawn as source, so such a fixture puts `x` and an empty line before it.
- **Long text.** `LONG` is `alpha beta gamma delta ` written 15 times, then `end`: 348 characters, no newline. In the 1920 px window it wraps to at least three visual lines. `LONG@n` is `LONG` with `‸` after its n-th character. `WRAP` is `the quick brown fox jumps over the lazy dog` written 14 times, joined by spaces, with its source lines filled to at most 77 characters: a line takes words while it stays within 77, and a newline replaces the space before the next word. It is 615 characters on 8 source lines, with no final newline. `BIG` is `the quick brown fox jumps over the lazy dog ` written 30 times, then `end`: 1323 characters on one line. In the 1920 px window both wrap at points that are not source newlines. `WRAP@n` and `BIG@n` place `‸` as `LONG@n` does. `URL` is `https://x.test/` followed by 385 `a`, with no newline. A source or an expectation may be written as pieces joined by ` + `, each a literal or one of these names.
- **Filler.** `FILL` is `filler 1\n\nfiller 2\n\n` and so on through `filler 60\n\n`.
- **Marks.**
  - `‸` is the caret, which is the focus of the selection.
  - `«` is the anchor of a selection that is not collapsed.
  - Neither mark is in any file; the harness removes them before writing.
  - In an expectation, the marks give the bytes and the caret after the keys.
- **Cell shape.** The expectation follows the last ` → ` on the line, because `→` is also a key. `same` means the bytes and the caret did not change, and the rev did not move. A note after `·` is a further check on that cell. `[D#]` and `[U]` on a cell name the rule source the cell depends on.
- **Keys.** Keys are written as pressed:
  - `x` types x, and `"ab"` types a then b;
  - `Enter`, `Shift+Enter`, `Backspace`, `Delete`, `Ctrl+Backspace`, `Ctrl+Delete`, `Tab`, `Shift+Tab`, `Escape`;
  - `←`, `→`, `↑`, `↓`, `Shift+←`, `Shift+→`, `Shift+↓`, `Ctrl+→`;
  - `Home`, `End`, `Shift+Home`, `Ctrl+Home`, `Ctrl+End`, `PageDown`;
  - `Ctrl+A`, `Ctrl+C`, `Ctrl+X`, `Ctrl+V`, `Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+Y`;
  - `compose A, B` sends composition steps, and `commit C` ends the composition with `C`;
  - `read` has another client open the file with `node cli.js show`, as an agent reading it would. The harness then waits for quiet.
  - `reconnect` drops the page's socket at the harness's proxy. The page retries, and the harness waits for the `file` message before the next key.
  - `offline` drops the page's socket and refuses new connections, so the page stays away while the next keys run. `online` accepts connections again and waits for the `file` message.
  - `walk` presses → until the caret stops moving. At every stop, it checks three things:
    - the caret moved forward;
    - it is not strictly inside a hidden marker, meaning hard-break spaces or a backslash after the end of a line's text (D17), or the inside of a comment marker (D6);
    - it is drawn at its boundary.

    The cell's expectation is where the walk stops.
  - **`B:`** sends the rest of the action to B, a second user logged in as `qa-two` who has the same file open. B talks to the hub directly: a browser test drives one browser, so B is never a second page. `B: click X` puts B's caret at that place and holds its block, and `B:` with letters types them at B's caret. Everything without a prefix goes to the page, A, logged in as `qa-bot`.
  - **`agent:`** runs one CLI command as user `qa-cli`, as an agent would:
    - `prepend "T"` and `append "T"` add `T` at the start or the end of the file, with `edit`;
    - `replace "O" with "N"` changes the first `O`, with `edit`;
    - `comment "T"` adds a comment on the first `T`, with `comment add` and the question `Why?`.

    `(refused)` after an agent command means the hub must answer 409 and change nothing.
  
  Keys separated by commas are pressed in order, and the expectation is checked once, after the last.
- **Pointer actions.**
  - `click X¦Y` clicks the drawn text `XY` at the boundary `¦`: 1 px inside the left edge of the glyph after `¦`, or 1 px inside the right edge of the glyph before it when `¦` ends the text.
  - `Shift+click X¦Y` does the same with the Shift modifier.
  - `middle-click X¦Y` uses the middle button.
  - `dblclick W` and `tripleclick W` press 1 px left of the center of the middle glyph of the drawn word `W`.
  - `at the top of its line` after a text target keeps the same x and presses 2 px under the top edge of the line that draws the text, in the band above its glyphs that still belongs to the line. `at the bottom of its glyphs` presses 2 px above the bottom of the text's first glyph. The bottom edge of a paragraph's line is not used, because that line's box also holds the gap under the paragraph.
  - `drag A¦B to C¦D` presses at the first boundary and releases at the second.
  - `drag the selection to X¦` presses inside the selected text and releases at the boundary, as a drag-and-drop.
  - `click rule`, `click image`, `click diagram`, `click cell T`, `click table edge`, `click bullet`, `click bar`, and `click below` name a drawn target. `click below` is 40 px under the last line. `click the left half of the tab` and `click the right half of the tab` press 1 px inside that edge of the first tab drawn.
  - Drawn text that appears more than once is followed by which one, such as `(2nd)` or `(9th)`.
- **Other sessions.** After the expectation, `; B → X` gives the bytes as B last heard them from the hub, and B's caret. A note `B sees the name N on T` checks that the hub's locks message to B names `N` as the holder of the block holding `T`. `B no longer sees the name N on T` checks that it does not.
- **Position-only expectations.** No expectation depends on glyph widths. Where the exact offset after a move would, the expectation names only what does not depend on widths. The bytes must not change in any of them.
  - `on X`: the caret is somewhere on the source line that holds `X`.
  - `later in the block`: the caret is after where it started, in the same block.
  - `earlier in the block`: the caret is before where it started, and after the start of the block.
  - `later in the file`: the caret is after where it started.
  - `the end of its visual line`: the caret is after the last character on the visual line it started on, a space included. That is the first offset whose glyph the page draws on a later line, so the page's own layout gives it. The caret is drawn on the line it started on (R74).
  - `the start of its visual line`: the caret is at the first character drawn on the visual line it started on, after any marker drawn as nothing. It is drawn on that line, not at the end of the line above (R74).
  - `at X`: the caret is at the `‸` inside the one place `X` occurs in the bytes. The rest of the bytes are not checked, for when another client adds something whose bytes cannot be known in advance, such as a comment's timestamp.

Routes: A route is how the caret reaches the source's `‸` before the keys.

- **`click` (the default).** The harness clicks the boundary as `click X¦Y` does.
- **`drag` (the default for a source that holds a selection).** The harness presses at `«` and releases at `‸`, as `drag A¦B to C¦D` does. A cell may name the direction, such as `drag` backward.
  - When the boundary touches a hidden marker, or sits inside a closed atom, the harness first clicks the block or the atom once so its source is drawn, then clicks the boundary.
  - A boundary inside a closed table is reached by clicking the nearest cell first.
  - A boundary after the final newline is reached with `click below`.
- **`↓`.** Place the caret at the end of the line above by the `click` route, which opens an atom first, then press `↓`.
- **`↑`.** Place the caret at the start of the line below's text by the `click` route, then press `↑`.
- **`←`.** Place the caret at the start of the line below's text, then press `←`.
- **`→`.** Place the caret at the end of the line above, then press `→`.
- **`emptied`.** The source gets `x` at the caret. The harness clicks right after the `x` and presses Backspace, which must leave exactly the cell's source and caret; only then are the cell's keys pressed.
- **`cleared`.** Like `emptied`, with `xyz`: double-click `xyz`, then press Backspace. A triple-click would select the whole block (R85), and `xyz` often soft-joins the next line.
- **`undone`.** Place the caret by `click`, type `x`, then press Ctrl+Z.
- **`margin`.** Click 8 px left of the target line's box.
- **`far`.** Click 20 px from the right edge of the editor, at the target line's y.
- **`gap`.** Click 1 px below the top of the target line's box.
- **`remote`.** Place the caret by `click`. Then run `node cli.js --port PORT --user qa-cli --repo qa edit FILE` with a diff that inserts `zero\n\n` at the start of the file. Before the keys, the bytes gain that prefix, and the caret moves 6 later (R94).
- **`remote-below`.** The same, but appending `\n\nlast\n` at the end of the file. The caret does not move.
- **`reconnect`.** Place the caret by `click`. Then the harness's proxy drops the page's socket. AGENTS.md says the page retries; the keys go after the `file` message arrives again.
- **`resize`.** Place the caret by `click`. Then set the window width to 700, then back to 1920.
- **`refocus`.** Place the caret by `click`. Then `Target.createTarget` opens `about:blank`, and `Target.activateTarget` returns to the page.
- **`scrolled`.** The file is `FILL` followed by the source. Scroll with the mouse wheel until the target line is in the middle of the viewport, then place the caret by `click`.

Which routes run:
- Every `BG` cell runs the `click`, `↓`, `↑`, and `emptied` routes. A route is left out only where it cannot exist: there is no `↓` with no line above, and no `↑` with no line below.
- Four `BG` cells also run every other route: `BG.h-p`, `BG.tb-p`, `BG.p-eof`, and `BG.fb-fb`. These are `←`, `→`, `cleared`, `undone`, `margin`, `far`, `gap`, `remote`, `remote-below`, `reconnect`, `resize`, `refocus`, and `scrolled`.
- A cell that lists routes runs those. A cell with no list runs `click`.
- After a route, the harness checks the mapped caret against `‸`. When the two differ, the cell is BLOCKED with `placement`, and the route itself is reported FAIL under that cell's id with the suffix `/route`.

Passes: each pass uses a fresh file. P1 runs every route a cell lists. P2 to P5 run each cell once, by the first route listed for it.
- **P1 main.** Every cell, with every invariant.
- **P2 undo.** Every cell that edits. I6.
- **P3 probe.** Every cell. I9.
- **P4 burst.** The `EB`, `EF`, `BG`, `DL.bl`, and `UR.6` cells, and `BG.rep.1`. The keys go 30 ms apart without waiting for quiet. A repeated Backspace is sent as `autoRepeat: true` keydowns, 33 ms apart. The harness then waits until the rev equals the starting rev plus the number of edits in the expectation, and checks I1 to I4.
- **P5 latency.** The same cells as P4, run through a Node `net` proxy between the page and the hub that delays every frame by 150 ms in each direction. Keys are sent as in P1.

Every cell, without saying so:
- **I1 bytes.** The hub's bytes equal the expectation exactly. They never hold a lone `\r`.
- **I2 caret.** The mapped caret equals the expectation's `‸`, and `«` where one is given. The selection is inside the editor root.
- **I3 drawn.** The caret is drawn at its boundary, inside the visual line that owns that offset. A selection is drawn over exactly its characters. This catches a caret that maps correctly but is shown somewhere else.
- **I4 raw.** The block holding the focus is raw, as R1 to R5 define, and no other block is.
- **I5 rev.**
  - Each key that edits moves the rev by exactly 1.
  - A key that does not edit, a click, or a selection moves it by 0.
  - In a cell with one user, no 409 arrives.
- **I6 undo (P2).** Where the cell edits, pressing `Ctrl+Z` once per edit afterwards gives back the bytes and caret from before the keys, drawn there. Pressing `Ctrl+Shift+Z` the same number of times gives the cell's expectation again.
- **I7 quiet.** No `console.error` and no uncaught exception. No 4xx or 5xx response for `/`, `/editor.css`, `/src/`, `/vendor/`, or `/raw/`; `/favicon.ico` is ignored.
- **I8 stable.** Reload the page at the end, wait as Setup describes, then place the caret again by the same route. The same blocks are drawn, with the same text and the same rects within 1 px, and the caret is drawn at the same rect.
- **I9 probe (P3).** After the cell's keys, press `Q` as a real key.
  - The bytes must equal the expectation with `Q` at `‸`, or with `Q` in place of the selection.
  - Then press Backspace. The bytes must equal the expectation again, or the expectation with the selection deleted.
  - This checks where the next edit lands, without trusting `mapOffset`.
- **I10 view.** After every key, the caret's rect is inside the viewport. On a `scrolled` route, `scrollY` changes only as much as keeping the caret inside the viewport needs.
- **I11 settled.** 500 ms after quiet, I2 and I3 still hold. This catches a late re-render, such as a diagram finishing, an image decoding, or a lock grant.
- **I12 typed.** The probe's `Q` (I9) is drawn where the caret was drawn just before the key: on the same visual line, within 3 px of the caret's x. It is skipped for a selection and for a caret the page draws nowhere. On an empty line, the caret is the line's own box (R99). A `Q` typed at the end of a word that just fits carries the word onto the next visual line; then the `Q` must sit right after the glyph before it, on that glyph's new line. Where the caret is drawn at the end of a visual line and the character after it starts the next visual line, the caret is at a wrap: the `Q` goes in at the caret and wraps as normal text does, so it must sit right before that character, on that character's line (R99, R74). A soft-wrap point gets no other allowance.
- **I13 comments.** After the cell, each comment id in the hub's bytes opens once and closes once after it, has one fence, and crosses no other comment (R101). Markers inside a fence body are text and are not read.

Result: Each cell is PASS, FAIL, or BLOCKED with a reason. A FAIL is run twice more and reported as `k/3`, because some failures come and go.

A FAIL records:
- every invariant or note that failed, not only the first;
- the bytes, and the mapped caret;
- the DOM anchor and focus as a node path and offset;
- the drawn rect, and whether it came from the fallback;
- the frames the page sent (`Network.webSocketFrameSent`), which show the splice it asked for, and the frames it received;
- the passive event log for the cell;
- the editor's `outerHTML`.

A failure whose cell depends on a `[D#]` may mean the default needs revising rather than the code.

Out of scope: these are not cells below.
- the ticket pane, the comment cards in the sidebar, the file tree, login, and repo switching;
- the locking rules themselves, which `qa/lock-spans-test-plan.md` covers. What a person sees and can do while another session or an agent holds or edits text is in scope, in section `MS` and the `remote` and `reconnect` routes;
- the drawn diagram itself, and Prism's colors;
- a Ctrl+B bold command, which is not a feature yet;
- checkboxes drawn for task items, which the page does not draw;
- an item with several paragraphs, and front matter, which the dialect does not have;
- right-to-left text beyond the one smoke cell `MV.rtl.1`;
- emoji, combining accents, and other characters longer than one code unit.

In scope for comments: the markers in the prose, and what keys do at them. A comment's opening marker is its id in braces, and its closing marker is the same id after a slash, in braces. Both are written out only inside the cell fences below, because this dialect reads them as comment markers anywhere else, including inside a code span.

Cleanup: The harness closes the browser, stops the proxy and the hub, and removes the state directory and the repo directory. It removes `PROFILE` unless `VIEWMARK_KEEP_PROFILE=1` is set.

## Decisions
The owner decided these `[U]`:
- Enter continues a quote with `> `, and Enter on an empty quote line leaves the quote.
- Enter inside a paragraph makes a paragraph break.
- Enter on an empty item leaves the list, or outdents a nested item.
- A double-click selects the word without its markers.
- Tab and Shift+Tab indent and outdent list items.
- Backspace on an empty line removes the line and draws the caret at the end of the line above.

The owner approved D1 to D22 as correct enough to start. A later default is approved unless it says it is not, or says which part is QA's reading. A change to a default changes the cells listed with it.

- D1. Text typed on the line Enter gives the caret is drawn as its own block. Where the dialect would join it to a neighbor, Enter writes a blank line between them (R22, R24).
  - Why: with a single newline, text typed on the new line joins the paragraph next to it with a space. That looks like Enter did nothing.
  - Cost: Enter at the end of a paragraph leaves an empty line between the paragraph and the caret. One Backspace right after Enter takes it all back (R18).
  - Cells: `EN.p.2`, `EN.p.3`, `EN.p.5`, `EN.p.6`, `EN.bl.2`, `EN.h.3`, `EN.hr.3`, `EN.fc.6`, `EN.li.8`, `EN.li.10`, `EN.ol.5`, `EN.q.4`, `EN.tk.4`, and the `EB` and `EF` cells.
- D2. The empty line after a final newline is drawn while the caret is on it. The caret can get there by a click below, by ↓, or by Enter (R3, R73, R83). The first character typed there under a paragraph, an item, or a quote starts its own block (R11).
  - Why: otherwise the caret at the end of such a file has no line. `placeCaret` finds no point, and the DOM caret keeps its last position, so the next Backspace acts on the wrong character.
  - Contradicts: `[T a trailing newline is not its own block]`, but only while the caret is on that line.
  - Cells: every `EF` cell, `EN.p.3`, `EN.fu.1`, `TC.tb.1`, `UR.11`, `BG.p-eof`, `BG.p-eof2`, `MV.av.5`, `CK.eof.1`.
- D3. Enter at the start of a block's text pushes the block down (R25). Without it, Enter at the start of a heading would split it into an empty heading and a paragraph. Cells: `EN.h.4`, `EN.p.4`, `EN.q.3`, `EN.hr.2`, `EN.li.5`.
- D4. Ordered items and Enter:
  - Item continuation applies anywhere in the item's block, including a lazy continuation line.
  - Later ordered items are renumbered, as Obsidian does, and an item indented into a new level becomes `1`.
  - A fence body gets a plain newline (R27).
  - A line starting with `|` gets a plain newline, so a table can be typed (R28).
  - A selection is deleted before Enter acts (R29).
  - Cells: `EN.li.11`, `EN.ol.4`, `EN.fc.3`, `EN.tb.1`, `EN.tb.2`, `TC.tb.1`, `TB.ol.1`, `EN.sel.*`, `SX.3`.
- D5. Backspace directly after a list, task, or quote marker removes the marker, or outdents a nested item (R32).
  - Why: it undoes Enter's continuation in one key, as in Obsidian.
  - The alternative is one character per press. Then `- ‸` becomes `-‸`, which the dialect joins to the item above as text.
  - Cells: `BS.q.*`, `BS.li.1`–`BS.li.3`, `BS.ol.*`, `BS.nl.*`, `BS.ql.*`, `BS.tk.*`, `EB.*`.
- D6. Comment markers (R37, R38, R39):
  - A marker is never cut, and the caret never rests inside one.
  - A selection delete that takes one marker keeps the comment on what is left.
  - Why: without this rule arrows and clicks can stop inside a marker, and typing there breaks the comment. In the raw block the markers are drawn as handles (R105).
  - Cells: `BS.cm.2`, `BS.cm.4`, `DL.cm.2`, `MV.cm.1`, `MV.cm.2`, `SX.10`.
- D7. Ctrl+Backspace and Ctrl+Delete delete by group, so markers and words are separate groups (R50). Cells: `WB.*`, `WD.*`.
- D8. Tab on an item inserts `\t` at the line start. Shift+Tab removes one `\t`, or up to four spaces. A quoted item is left alone. Off a list, Shift+Tab keeps focus in the editor (R60, R62). Cells: `TB.*`.
- D9. → from the end of a line lands after the next line's hidden marker (R71). Cells: `MV.li.1`, `MV.h.1`, `MV.q.1`, `MV.hr.1`.
- D10. ↑ and ↓ keep a goal x across presses (R73). Cells: `MV.av.*`.
- D11. Movement keys (R74, R75, R90):
  - Home is smart: it goes after the marker first, as in Obsidian. End stops before hidden trailing markers.
  - Ctrl+Home, Ctrl+End, PageUp, PageDown, Ctrl+A, and Escape are the browser's own.
  - The next edit acts where they leave the caret.
  - Cells: `MV.he.*`, `MV.ce.*`, `MV.pg.1`, `MV.esc.1`, `SX.7`, `SX.8`, `SX.11`, `CB.1`, `CB.4`, `EF.15`.
- D12. Clicks and drags (R81, R82, R86):
  - A click on a rule puts the caret at the start of the rule's line.
  - A click on a bullet or a quote bar lands after the marker.
  - A drag maps both of its ends against the text as it was drawn at the press.
  - Cells: `CK.hr.1`, `TY.hr.1`, `CK.li.2`, `CK.q.2`, `DG.*`.
- D13. A word for double-click is a word-like `Intl.Segmenter` segment, with markdown markers trimmed from its ends (R84). This matches Chromium's own double-click, and handles `don't`, `3.14`, `x.test`, and Japanese. Cells: `DC.*`.
- D25. Undo and redo act only on this session's own edits (R98). An edit by another person or an agent between two of this session's edits is not undone by its Ctrl+Z, and the caret goes back to its place in the text as it is now. Cells: `MS.5`, `MS.9`. Not approved.
- D14. A caret at the end of a table's last row, or of a diagram's closing line, is inside the atom, which opens (R2, R34, R72).
  - Why: typing at the end of the last row puts the caret there (`TC.tb.1`, `EN.tb.2`). Closing the table under the caret while a person types in it is wrong. It also hides where the caret is drawn.
  - Contradicts: `[T T-backspace-atom]`, where one Backspace at a closed table's end deletes the whole table, and `[T T-snap-rendered]`, where ← into a table lands at end − 1.
  - Cells: `BG.mm-p`, `EB.tb.1`, `EN.tb.1`, `EN.tb.2`, `TC.tb.1`, `MV.tb.2`, `BS.tb.1`, `UR.9`.
- D15. Delete at the end of a visual line whose break is hidden, as with two trailing spaces, removes the break (R42), and by D35 its hidden markers with it. The alternative removes an invisible space and turns the break into a soft join. Cells: `DL.hb.1`, `DL.hb.2`.
- D16. A line drawn empty is empty for Backspace and Delete (R30, R40). That includes a line of spaces, a line holding a tab, a `\r` line, and a line of spaces inside a paragraph. It has one caret position, at its start (D17): a click, ↓, and ↑ all land there. Otherwise Backspace removes one invisible character and nothing visibly changes, which is the reported symptom. Cells: `BG.ws.*`.
- D17. The end of a line is before its hidden trailing markers (R30, R70, R74). Offsets 3, 4, and 5 of `red  \n` draw at the same x, and this decides which one a caret means. Cells: `MV.hb.1`, `MV.he.9`.
  - The owner decided on 2026-10-16 that this does not hold for spaces just typed: after spaces typed at the end of a line, the caret is drawn after them, not back before them `[U]` (ticket xhx944ku).
- D18. A `\r\n` file is drawn and edited as `\n`, and keeps its line endings (R5, R91). Cells: `CR.*`.
- D19. A task item `- [ ] ` continues as `- [ ] ` on Enter, and leaves the list when empty. Backspace removes `[ ] ` first (R20, R22, R32). Cells: `EN.tk.*`, `BS.tk.*`.
- D20. A middle-click pastes the primary selection, and a drag of selected text moves it (R88). Cells: `CK.mid.1`, `DD.1`.
- D21. Three dialect points the page draws and `qa/lock-spans-test-plan.md` does not state (R4).
  - An image alone on a line is its own block.
  - A non-pipe line ends a table. GitHub would take it as one more row.
  - A rule is exactly three characters.
  - Cells: `BG.im-p`, `BG.p-im`, `EN.im.1`, `DL.im.1`, `MV.tb.2`, `TB.hr.1`.
- D22. Shift+click extends the selection (R87). Cells: `CK.sh.*`.
- D26. When the hub refuses this session's own edit with 409, the page shows it without new chrome (R97). If another session holds the span, that session's lock label on the block flashes for about a second. While it flashes, the label has a class besides `md-lock`, or a running animation. If no session holds the span, the caret's line flashes the same way. The refused key and the keys queued behind it are dropped, and the caret stays where the hub last granted it. A key replayed after a silent socket is shown the same way. Cells: `MS.16`. No new chrome is the owner's choice. The flash is QA's way of meeting it, and is not approved.
- D27. A paragraph that wraps (R74, R99). Where a visual line wraps at a space, or at a soft newline drawn as a space, that space hangs past the line's last word and is not seen. The offset after it ends that line and starts the next one.
  - End goes after that space, and the caret is drawn at the end of the line it was on. A letter typed there goes in after the space, and wraps with the next word to the start of the next line. This part is the owner's rule (R74), not a proposal. A line that breaks inside a word, as a long URL does, is the same: End goes after its last character, and a typed letter starts the next line.
  - QA proposes that a click past the line's last word, and ↓ or ↑ toward the end of a line, land where End does.
  - QA proposes that Home, and a click before the next line's first word, land after the space too, with the caret drawn at the start of the next line, where a typed letter appears.
  - Cells: `MV.he.8`, `MV.he.11` to `MV.he.14`, `MV.lg.1`.
  - The rest of D27 is not approved.
- D28. The form of Shift+Enter's hard break (R26).
  - It writes a backslash and the file's newline at the caret: `he‸llo` → `he\\\n‸llo`.
  - In a quote, the new line starts with `> `.
  - A heading cannot hold a break, so Shift+Enter on a heading is Enter. In a fence it writes one newline, as R27.
  - The line after a hard break belongs to the block above, so R11's newline-first does not apply there.
  - Cells: the `SE` cells.
  - Approved on a condition: the markdown has to stay valid, and its rendering has to read sensibly. So, with a word typed after the break, the file keeps the new line in the same block, and the rendered block draws it on its own line with no backslash. CommonMark reads a backslash at the very end of a block as a backslash, so Shift+Enter with nothing typed after it leaves a file another renderer draws with a backslash. R1 says the page hides it, and `browser/shift-enter.browser.js` checks that it does, with a word typed after the break and without. QA's proposal for a clean form of that case, one other viewers render as the page draws it, is on ticket `acc28bfp`, not approved. In a quote or an item whose paragraph runs over two source lines, Shift+Enter at the end of the first line puts the caret after the next line's `> ` or indent (`SE.q.2`, `SE.li.2`).
- D29. Where Ctrl+← and Ctrl+→ stop (R70).
  - The owner's rule: Ctrl+← and Ctrl+→ move to the previous or next word, with words split at spaces as a person would split them, the same in raw and in rendered mode. That decides two things. Spaces separate words, so punctuation and markdown markers are part of the word they touch: `**bold**`, `don't`, and `alpha,` are each one word. The stops are the same in raw and rendered mode.
  - QA's reading of the rest, not approved. Ctrl+→ goes to the start of the next word, since the answer says to skip to it; with no word after the caret, it goes to the end of the last word. Ctrl+← goes to the start of the word the caret is in, or, at a word's start or in the spaces after a word, to the start of the word before. A newline counts as a space. In rendered mode, the caret at the start of `**bold**` is drawn before `bold`.
  - Shift extends the selection. That is QA's; the answer does not mention it.
  - Cells: `MV.sh.4`, `MV.cw.*`.
- D30. Comments stay whole, and moving one moves its markers (R100 to R102).
  - Why: moving a comment's markers, or deleting a comment, must not write a marker twice or lose the caret.
  - Cells: I13 on every cell; `browser/comments.browser.js`.
  - Not approved.
- D31. Where the caret stays after Delete on an empty line (R40).
  - The owner's rule: Delete pulls the previous line up, and the page then copes with whatever that does to the markdown below it.
  - QA's reading, not approved. Delete removes the empty line, so the line under it moves up into its place. The page then changes whatever else the markdown needs, so every block keeps its kind and the page shows the same blocks, one line closer. Delete removes what follows the caret, so the previous line, in the owner's answer, is read as the line under the empty one.
  - The caret stays at the start of the line that moved up, before any markdown marker on it. Whether that is before `- ` or before `a` is not decided.
  - Examples: `# Title\n‸\n- a\n` becomes `# Title\n‸- a\n`, the item right under the heading. `- a\n‸\n# Next\n` becomes `- a\n‸# Next\n`. `‸\ntwo\n` becomes `‸two\n`. None of these needs another change, because a list can start under a heading and a heading ends a list.
  - Where removing the line would change a block: in `- a\n‸\nnext\n`, removing the blank line gives `- a\nnext\n`, which markdown reads as one item, `a next`. The same happens after a quote, and after a table, where the next line is read as another row. The file needs that blank line to keep `next` a paragraph. QA proposes that the page draw such a blank line as R7 draws the one between paragraphs, with no height and no caret stop, so there is no empty line there to delete. Not approved.
  - Cells: `DL.bl.*`.
- D32. Where a triple-click's selection starts and ends (R85).
  - It runs from after the first line's markdown marker (`- `, `1. `, `> `, `# `, a task's `[ ] `) to the end of the block's last line, without its newline.
  - A block is a paragraph, a heading, a list item, or a quote paragraph, as AGENTS.md lists locks. In a fence it is the body lines, not the fence lines. On an empty line nothing is selected.
  - Why: as R84 trims markers from a word, an edit or a comment over the selection keeps the block's kind (R103).
  - Cells: `T3.*`.
- D33. A run of typing as one undo step (R92).
  - A run is typed characters, spaces included, each written right after the one before, with no other key, click, or edit by this page between them.
  - A run ends at a caret move by any key or click; at a key that is not a character, such as Enter, Backspace, Delete, Tab, or an arrow; at a paste, a cut, a drop, or a comment action; at Ctrl+Z or Ctrl+Y; at a pause of more than one second between keys; and at an edit by another session or an agent that lands in the run's block.
  - Typing over a selection starts a run, and the replaced text belongs to it.
  - Ctrl+Z undoes the whole run and puts back the bytes and the caret from before its first character. Ctrl+Shift+Z or Ctrl+Y redoes the whole run and puts the caret after its last character.
  - Undo still acts only on this session's own edits (R98). Text another session wrote inside the run stays after the undo.
  - Composed text joins the run as typed characters do, once it is committed (R93).
  - Each character is still sent to the hub as it is typed, so other sessions see it at once. Only the undo history groups it.
  - Cells: `UR.1`, `UR.g.1` to `UR.g.6`.
- D34. Backspace and Delete where the markdown has a blank line that the rendered text does not show (R7, R18). This is QA's reading of the owner's rule (R18), not approved.
  - On the empty line directly under a paragraph, an item, or a quote, after one blank line, Backspace removes the empty line and the blank line. The caret goes to the end of the line above them. It does not matter how the caret got there, or what happened since: `EB.p.5`, `EB.p.6`, and `EB.p.7`. When another block follows the empty line, only the empty line goes, and the blank line above it stays, so the blocks stay apart: `one\n\n‸\ntwo\n` becomes `one‸\n\ntwo\n`. Removing the blank line too would give `one\ntwo`, one paragraph drawn `one two` (`BG.p-bl3`, `BG.rep.1`).
  - At the start of a paragraph directly under another paragraph, with one blank line between them, Backspace joins the two with no space: the blank line and the newline both go. Delete at the end of the first paragraph does the same. So `he\n\n‸llo` becomes `he‸llo`, and `one\n\n‸two` becomes `one‸two`. The blank line under a list item or a quote has no height either, so QA proposes the same there: `- alpha\n\n‸two` becomes `- alpha‸two`, and `> alpha\n\n‸two` becomes `> alpha‸two` (`BS.pad.3`, `BS.pad.4`).
    - Why: the person sees two paragraphs, with no space between the end of one and the start of the next, so the join writes none.
    - It matches R33, the owner's rule that a hard break joins its two lines directly.
    - Spaces at the end of the first paragraph are not seen, so they go too. Kept, they would turn the newline into a hard break, and `blue` in `red  \n\n‸blue` would be drawn on a line of its own in the same paragraph.
  - After Enter on an item or a quote line, Backspace removes one marker, as R32 does at that place. Whether a later ordered item is renumbered then is not decided; `EB.ol.2` expects `1. a\n2. ‸\n3. b\n` to give `1. a\n‸\n3. b\n`, which is what the page does.
  - Cells: `EB.*`, `EF.3`, `EF.4`, `EF.9`, `BS.pad.1` to `BS.pad.4`, `DL.pad.1`, `DL.pad.2`.
- D35. Delete before a hard break removes its hidden markers too (R42), as Backspace does after one (R33). Hidden markers are not the person's problem. Cells: `DL.hb.1`, `DL.hb.2`.
- D36. Retired. R106 replaces it: a closed tab lets go of its file and its blocks at once.
- D37. A rename or a move keeps each session's caret at its place in the text (R106, R94). The owner's rule: renaming a file does not touch the caret of anyone who has it open. Tested by `browser/file-life.browser.js`.


## Coverage
`node --test` reports how many cells and routes ran. P1 runs each cell once per route it lists, and the `DC` and `T3` cells at two press intervals.

The cells are grouped by construct and by action. Some pairs of a construct and an action have no cell:
- **Covered by a parent construct.** A soft-wrapped paragraph, a hard break, and a quote continuation behave as a paragraph for word delete, Tab, double-click, triple-click, and drag. Ordered, nested, quoted, and task items behave as bullet items and quotes for Delete, word delete, moving, double-click, and triple-click. A cell there would repeat one above it.
- **Blank line.** Backspace on an empty line is the `BG` section. The caret cannot stop on the blank line between blocks (R7). There is no text to drag over.
- **No text to pick.** A rule draws no text, so double-click and triple-click have nothing to pick; R82 covers clicking it.
- **Atoms.** A closed diagram, table, or image is a single unit. Once it opens it is source text, so word delete, Tab, triple-click, and drag on it behave as in a fence or a paragraph. An inline image is inside a paragraph line, so it has no empty-line case of its own.
- **Unclosed fence.** It differs from a closed one only at the end of the file. That case is `EF.13`, `BS.fu.1`, and `EN.fu.1`.
- **Comments.** The markers are the only part special to a comment. Enter then Backspace, Tab, triple-click, and drag reach them only through cells that are already listed, such as `SX.10` and `EN.cm.1`.
- **Inline marks and links.** Delete, Tab, and triple-click inside a mark or a link act as in plain prose. The marker cases are in `BS.mk.*`, `DL.mk.1`, `WB.mk.*`, and `DL.lk.1`.
- **Files with `\r\n`.** These cells test the one thing that differs: a lone `\r`. The other actions go through the same code as the cells above.
- **Start and end of file.** These matter only for where the caret can be, so word delete, Tab, double-click, triple-click, and drag there act as on any line.
- **Ranges.** Selections (`SX`), clipboard (`CB`), undo (`UR`), composition (`IM`), and drags and drops across constructs act on a range, not on one construct.

## Cells
### TY: typing (R10)
```text
- `TY.p.1` `alpha‸ beta\n` x → `alphax‸ beta\n`
- `TY.p.2` `‸alpha beta\n` x → `x‸alpha beta\n`
- `TY.p.3` `alpha beta‸\n` x → `alpha betax‸\n`
- `TY.sp.1` `alpha\n‸beta\n` x → `alpha\nx‸beta\n` · one block `alpha xbeta`
- `TY.sp.2` `alpha‸\nbeta\n` x → `alphax‸\nbeta\n` · one block `alphax beta`
- `TY.hb.1` `red  \n‸blue\n` x → `red  \nx‸blue\n` · one block, drawn on its second visual line
- `TY.bl.1` `one\n\n‸\n\ntwo\n` x → `one\n\nx‸\n\ntwo\n` · `x` is its own block
- `TY.h.1` `# ‸Title\n` x → `# x‸Title\n`
- `TY.h.2` `# Ti‸tle\n` x → `# Tix‸tle\n`
- `TY.h.3` `# Title‸\n` x → `# Titlex‸\n`
- `TY.h.4` `###### ‸Title\n` x → `###### x‸Title\n` · level 6
- `TY.h.5` `# ‸\n` x → `# x‸\n` · a level-1 heading `x`
- `TY.hr.1` `one\n\n‸---\n` x → `one\n\nx‸---\n` · prose `x---`, no rule · route `click rule` [D12]
- `TY.q.1` `> ‸alpha\n` x → `> x‸alpha\n`
- `TY.q.2` `> alpha‸\n` x → `> alphax‸\n`
- `TY.q.3` `> ‸\n` x → `> x‸\n` · one bar
- `TY.qc.1` `> alpha\n‸beta\n` x → `> alpha\nx‸beta\n` · one quoted block `alpha xbeta`
- `TY.li.1` `- ‸alpha\n` x → `- x‸alpha\n`
- `TY.li.2` `- alpha‸\n` x → `- alphax‸\n`
- `TY.li.3` `- ‸\n` x → `- x‸\n`
- `TY.li.4` `+ ‸alpha\n` x → `+ x‸alpha\n`
- `TY.li.5` `* ‸alpha\n` x → `* x‸alpha\n`
- `TY.ol.1` `1. ‸alpha\n` x → `1. x‸alpha\n`
- `TY.ol.2` `1) ‸alpha\n` x → `1) x‸alpha\n`
- `TY.nl.1` `- a\n  - ‸b\n` x → `- a\n  - x‸b\n`
- `TY.nl.2` `- a\n\t- ‸b\n` x → `- a\n\t- x‸b\n`
- `TY.ql.1` `> - ‸alpha\n` x → `> - x‸alpha\n`
- `TY.ql.2` `> 1. ‸alpha\n` x → `> 1. x‸alpha\n`
- `TY.fc.1` "```js\nlet ‸x\n```\n" y → "```js\nlet y‸x\n```\n" · the fence is drawn as source with its fence lines
- `TY.fc.2` "```js\nlet x\n‸\n```\n" y → "```js\nlet x\ny‸\n```\n"
- `TY.fu.1` "```js\nlet x‸" y → "```js\nlet xy‸"
- `TY.mm.1` "x\n\n```mermaid\n‸graph TD\nA-->B\n```\n" x → "x\n\n```mermaid\nx‸graph TD\nA-->B\n```\n" · route `click diagram`
- `TY.tb.1` `x\n\n| a | b |\n| --- | --- |\n| ‸1 | 2 |\n` x → `x\n\n| a | b |\n| --- | --- |\n| x‸1 | 2 |\n` · route `click cell 1`
- `TY.tb.2` `x\n\n| ‸a | b |\n| --- | --- |\n| 1 | 2 |\n` x → `x\n\n| x‸a | b |\n| --- | --- |\n| 1 | 2 |\n` · route `click cell a`
- `TY.ii.1` `x\n\nsee ‸![box](box.svg) here\n` x → `x\n\nsee x‸![box](box.svg) here\n` · route `click image`
- `TY.cm.1` `See {c1}th‸is{/c1} now.` + CM, x → `See {c1}thx‸is{/c1} now.` + CM
- `TY.cm.2` `See {c1}‸this{/c1} now.` + CM, x → `See {c1}x‸this{/c1} now.` + CM · `x` is inside the highlight once the caret leaves
- `TY.cm.3` `See {c1}this{/c1}‸ now.` + CM, x → `See {c1}this{/c1}x‸ now.` + CM · `x` is outside the highlight
- `TY.mk.1` `a **bo‸ld** b\n` x → `a **box‸ld** b\n`
- `TY.mk.2` `a **bold‸** b\n` x → `a **boldx‸** b\n` · once the caret leaves, `boldx` is bold
- `TY.mk.3` `a **bold**‸ b\n` x → `a **bold**x‸ b\n` · once the caret leaves, `x` is not bold
- `TY.mk.4` `a *em‸* b\n` x → `a *emx‸* b\n`
- `TY.mk.5` "a `co‸de` b\n" x → "a `cox‸de` b\n"
- `TY.lk.1` `a [te‸xt](https://x.test/p) b\n` x → `a [tex‸xt](https://x.test/p) b\n`
- `TY.im.2` `‸x\n\n![box](box.svg)\n` click image, x → `x\n\nx‸` · a click selects the picture line, and typing replaces it (R81, R90)
```

### TC: typing that makes a construct (R10, R1)
```text
- `TC.h.1` `‸Title\n` "# " → `# ‸Title\n` · a level-1 heading; raw `# Title`
- `TC.h.2` `‸Title\n` "### " → `### ‸Title\n` · level 3
- `TC.li.1` `‸alpha\n` "- " → `- ‸alpha\n` · an item
- `TC.ol.1` `‸alpha\n` "1. " → `1. ‸alpha\n` · an ordered item `1.`
- `TC.q.1` `‸alpha\n` "> " → `> ‸alpha\n` · a quote bar
- `TC.hr.1` `one\n\n‸\n` "---", ↑ → `one\n‸\n---\n` · the third line is drawn as a rule once the caret leaves it
- `TC.fc.1` `one\n\n‸\n\ntwo\n` "```" → "one\n\n```‸\n\ntwo\n" · an unclosed fence through the end; `two` is code
- `TC.tb.1` `‸` "| a |", Enter, "| --- |", Enter, "| 1 |" → `| a |\n| --- |\n| 1 |‸` · one table, header `a`, one body row `1`, open as source while the caret is at its end [D2] [D4] [D14]
```

### EN: Enter (R20–R29)
Items.

```text
- `EN.li.1` `- alpha‸\n` Enter → `- alpha\n- ‸\n` · the marker is written before the final newline, not after it
- `EN.li.2` `- alpha‸\n- beta\n` Enter → `- alpha\n- ‸\n- beta\n` · three items
- `EN.li.3` `- al‸pha\n` Enter → `- al\n- ‸pha\n`
- `EN.li.4` `- ‸alpha\n` Enter → `- \n- ‸alpha\n`
- `EN.li.5` `‸- alpha\n` Enter → `\n‸- alpha\n` [D3]
- `EN.li.6` `+ alpha‸\n` Enter → `+ alpha\n+ ‸\n`
- `EN.li.7` `* alpha‸\n` Enter → `* alpha\n* ‸\n`
- `EN.li.8` `- alpha\n- ‸\n` Enter → `- alpha\n\n‸\n` · the caret's line has no marker, and no block is an item except `alpha` [U] [D1]
- `EN.li.9` `- ‸\n` Enter → `‸\n` [U]
- `EN.li.10` `- alpha\n- ‸\n- gamma\n` Enter → `- alpha\n\n‸\n- gamma\n` [U] [D1]
- `EN.li.11` `- alpha\nbe‸ta\n` Enter → `- alpha\nbe\n- ‸ta\n` · first item `alpha be` [D4]
- `EN.ol.1` `1. alpha‸\n` Enter → `1. alpha\n2. ‸\n`
- `EN.ol.2` `3) alpha‸\n` Enter → `3) alpha\n4) ‸\n`
- `EN.ol.3` `9. alpha‸\n` Enter → `9. alpha\n10. ‸\n`
- `EN.ol.4` `1. alpha‸\n2. beta\n` Enter → `1. alpha\n2. ‸\n3. beta\n` [D4]
- `EN.ol.5` `1. alpha\n2. ‸\n` Enter → `1. alpha\n\n‸\n` [U] [D1]
- `EN.tk.1` `- [ ] alpha‸\n` Enter → `- [ ] alpha\n- [ ] ‸\n` [D19]
- `EN.tk.2` `- [x] alpha‸\n` Enter → `- [x] alpha\n- [ ] ‸\n` · the new task is unchecked [D19]
- `EN.tk.3` `- [ ] ‸\n` Enter → `‸\n` [U] [D19]
- `EN.tk.4` `- [ ] alpha\n- [ ] ‸\n` Enter → `- [ ] alpha\n\n‸\n` [U] [D1] [D19]
- `EN.li.12` `- a‸\n# H\n` Enter → `- a\n- ‸\n# H\n`
- `EN.nl.1` `- a\n  - b‸\n` Enter → `- a\n  - b\n  - ‸\n`
- `EN.nl.2` `- a\n  - ‸\n` Enter → `- a\n- ‸\n` [U]
- `EN.nl.3` `- a\n\t- b‸\n` Enter → `- a\n\t- b\n\t- ‸\n`
- `EN.nl.4` `- a\n\t- ‸\n` Enter → `- a\n- ‸\n` [U]
- `EN.ql.1` `> - alpha‸\n` Enter → `> - alpha\n> - ‸\n`
- `EN.ql.2` `> 1. alpha‸\n` Enter → `> 1. alpha\n> 2. ‸\n`
- `EN.ql.3` `> - alpha\n> - ‸\n` Enter → `> - alpha\n> ‸\n` · one bar beside both lines [U]
- `EN.ql.4` `> - al‸pha\n` Enter → `> - al\n> - ‸pha\n`
```

Quotes.

```text
- `EN.q.1` `> alpha‸\n` Enter → `> alpha\n> ‸\n` · one bar beside both lines [U]
- `EN.q.2` `> al‸pha\n` Enter → `> al\n> ‸pha\n` [U]
- `EN.q.3` `> ‸alpha\n` Enter → `> \n> ‸alpha\n` [U] [D3]
- `EN.q.4` `> alpha\n> ‸\n` Enter → `> alpha\n\n‸\n` · no bar beside the caret's line [U] [D1]
- `EN.q.5` `> ‸\n` Enter → `‸\n` [U]
- `EN.q.6` `> alpha‸\n> beta\n` Enter → `> alpha\n> ‸\n> beta\n` [U]
- `EN.qc.1` `> alpha\nbe‸ta\n` Enter → `> alpha\nbe\n> ‸ta\n` · bar beside `alpha be` and `ta` [U]
- `EN.qc.2` `> alpha\nbeta‸\n` Enter → `> alpha\nbeta\n> ‸\n` [U]
```

Paragraphs.

```text
- `EN.p.1` `he‸llo\n` Enter → `he\n\n‸llo\n` · two blocks; the blank line between them is padding, not an empty line on screen (R7) [U]
- `EN.p.2` `hello‸\n` Enter → `hello\n\n‸\n` [D1]
- `EN.p.3` `hello‸` Enter → `hello\n\n‸` · the caret is drawn on its own line, directly under `hello`, with no empty line between (R7) [D1] [D2]
- `EN.p.4` `‸hello\n` Enter → `\n‸hello\n` [D3]
- `EN.p.5` `hello‸\n\nworld\n` Enter → `hello\n\n‸\n\nworld\n` [D1]
- `EN.p.6` `hello‸\n# Title\n` Enter → `hello\n\n‸\n# Title\n` [D1]
- `EN.sp.1` `alpha‸\nbeta\n` Enter → `alpha\n\n‸beta\n` [U]
- `EN.sp.2` `alpha\n‸beta\n` Enter → `alpha\n\n‸beta\n` [U]
- `EN.sp.3` `alpha\nbe‸ta\n` Enter → `alpha\nbe\n\n‸ta\n` · first block `alpha be` [U]
- `EN.hb.1` `red  \nbl‸ue\n` Enter → `red  \nbl\n\n‸ue\n` [U]
- `EN.bl.1` `one\n\n‸\n\ntwo\n` Enter → `one\n\n\n‸\n\ntwo\n`
- `EN.ii.1` `see ![box](box.svg)‸ here\n` Enter → `see ![box](box.svg)\n\n‸ here\n` [U]
- `EN.cm.1` `See {c1}th‸is{/c1} now.` + CM, Enter → `See {c1}th\n\n‸is{/c1} now.` + CM · the highlight covers `th` and `is` [U]
- `EN.mk.1` `a **bo‸ld** b\n` Enter → `a **bo\n\n‸ld** b\n` · neither line pairs its `**`, so both show them [U]
- `EN.lk.1` `a [te‸xt](https://x.test/p) b\n` Enter → `a [te\n\n‸xt](https://x.test/p) b\n` · neither line holds a link [U]
- `EN.sel.1` `al«pha be‸ta\n` Enter → `al\n\n‸ta\n` [D4]
- `EN.sel.2` `- al«ph‸a\n` Enter → `- al\n- ‸a\n` [D4]
```

Headings, rules, fences, tables, images.

```text
- `EN.h.1` `# Ti‸tle\n` Enter → `# Ti\n‸tle\n` · heading `Ti`, then the paragraph `tle`
- `EN.h.2` `# Title‸\n` Enter → `# Title\n‸\n`
- `EN.h.3` `# Title‸\nmore\n` Enter → `# Title\n‸\n\nmore\n` [D1]
- `EN.h.4` `# ‸Title\n` Enter → `\n# ‸Title\n` [D3]
- `EN.h.5` `# H‸\n- a\n` Enter → `# H\n‸\n- a\n` · no blank line, because neither a heading nor an item joins the caret's line
- `EN.hr.1` `---‸\n` Enter → `---\n‸\n`
- `EN.hr.2` `‸---\n` Enter → `\n‸---\n` [D3]
- `EN.hr.3` `---‸\ntwo\n` Enter → `---\n‸\n\ntwo\n` [D1]
- `EN.fc.1` "```js\nlet ‸x\n```\n" Enter → "```js\nlet \n‸x\n```\n"
- `EN.fc.2` "```js\nlet x‸\n```\n" Enter → "```js\nlet x\n‸\n```\n"
- `EN.fc.3` "```md\n- it‸em\n```\n" Enter → "```md\n- it\n‸em\n```\n" · no marker inside a fence [D4]
- `EN.fc.4` "```js‸\nlet x\n```\n" Enter → "```js\n‸\nlet x\n```\n"
- `EN.fc.5` "```js\nlet x\n```‸\n" Enter → "```js\nlet x\n```\n‸\n"
- `EN.fc.6` "```js\nlet x\n```‸\ntwo\n" Enter → "```js\nlet x\n```\n‸\n\ntwo\n" [D1]
- `EN.fu.1` "```js\nlet x‸" Enter → "```js\nlet x\n‸" · the caret's line is fence body [D2]
- `EN.mm.1` "x\n\n```mermaid\ngraph TD‸\nA-->B\n```\n" Enter → "x\n\n```mermaid\ngraph TD\n‸\nA-->B\n```\n" · route `click diagram`, then the boundary
- `EN.tb.1` `x\n\n| a |\n| --- |\n| ‸1 |\n` →, →, →, Enter → `x\n\n| a |\n| --- |\n| 1 |\n‸\n` · the caret's line is under the table, which closes once the caret leaves it · route `click cell 1` [D4] [D14]
- `EN.tb.2` `| a |\n| --- |\n| 1 |\n‸\n` "| 2 |" → `| a |\n| --- |\n| 1 |\n| 2 |‸\n` · one table with body rows `1` and `2`, open as source [D4] [D14]
- `EN.im.1` `x\n\n![box](box.svg)‸\n` Enter → `x\n\n![box](box.svg)\n‸\n` · the image stays its own block · route `click image`, then the boundary [D21]
```

### SE: Shift+Enter (R26)
```text
- `SE.li.1` `- alpha‸\n` Shift+Enter → `- alpha\\\n‸\n` · a hard break in the item, not a new item [U] [D28]
- `SE.q.1` `> alpha‸\n` Shift+Enter → `> alpha\\\n> ‸\n` [U] [D28]
- `SE.p.1` `he‸llo\n` Shift+Enter → `he\\\n‸llo\n` · one block on two visual lines [U] [D28]
- `SE.q.2` `> alpha‸\n> beta\n` Shift+Enter → `> alpha\\\n> ‸beta\n` · one quoted paragraph on two source lines: the newline after `alpha` becomes the break, and the caret is after the next line's `> `, before `beta` [U] [D28]
- `SE.li.2` `- alpha‸\n  beta\n` Shift+Enter → `- alpha\\\n  ‸beta\n` · the same in an item, with the caret after the continuation's indent [U] [D28]
- `SE.p.2` `alpha‸\nbeta\n` Shift+Enter → `alpha\\\n‸beta\n` · the same in a paragraph [U] [D28]
- `SE.h.1` `# Title‸\n` Shift+Enter → `# Title\n‸\n` · a heading holds no break, so this is Enter [D28]
- `SE.fc.1` "```js\nlet ‸x\n```\n" Shift+Enter → "```js\nlet \n‸x\n```\n" [D28]
```

### EB: Enter, then Backspace (R18, R20–R32)
Each cell starts from the state a person leaves after typing, then backs out.

```text
- `EB.p.1` `hello‸\n` Enter, Backspace → `hello‸\n` · Backspace on the empty line under a paragraph removes it and the blank line [U] [D34]
- `EB.p.2` `hello‸\n` Enter, Backspace, Backspace → `hell‸\n` · the second Backspace is an ordinary one [U] [D34]
- `EB.p.3` `he‸llo\n` Enter, Backspace → `he‸llo\n` · at the start of the second paragraph, Backspace joins the two with no space, as `BS.pad.1` does [U] [D34]
- `EB.p.4` `he‸llo\n` Enter, Backspace, Backspace → `h‸llo\n` [U] [D34]
- `EB.p.5` `hello‸\n` Enter, ↑, ↓, Backspace → `hello‸\n` · away and back to the same empty line, Backspace acts the same [U] [D34]
- `EB.p.6` `hello‸\n` Enter, x, Backspace, Backspace → `hello‸\n` · a letter typed and removed in between changes nothing [U] [D34]
- `EB.p.7` `one\n\n‸\n` Backspace → `one‸\n` · the place counts, not how it was made [U] [D34]
- `EB.li.1` `- alpha‸\n` Enter, Backspace → `- alpha\n‸\n` · Backspace removes the new item's marker, as R32 does at that place; it does not take back the Enter [U] [D5] [D34]
- `EB.li.2` `- alpha‸\n` Enter, Backspace, Backspace → `- alpha‸\n` · the second Backspace removes the empty line (R30) [U] [D5] [D34]
- `EB.ol.1` `1. alpha‸\n` Enter, Backspace → `1. alpha\n‸\n` · the new item's marker goes (R32) [U] [D5] [D34]
- `EB.ol.2` `1. a‸\n2. b\n` Enter, Backspace → `1. a\n‸\n3. b\n` · the new item's marker goes (R32); whether `b` is renumbered then is not decided, and this is today's result [U] [D5] [D34]
- `EB.nl.1` `- a\n  - b‸\n` Enter, Backspace → `- a\n  - b\n- ‸\n` · the new nested item is outdented one level, as R32 does at that place [U] [D5] [D34]
- `EB.q.1` `> alpha‸\n` Enter, Backspace → `> alpha\n‸\n` · the new line's `> ` goes (R32) [U] [D5] [D34]
- `EB.ql.1` `> - alpha‸\n` Enter, Backspace → `> - alpha\n> ‸\n` · the new quoted item's list marker goes, leaving `> ` (R32) [U] [D5] [D34]
- `EB.h.1` `# Title‸\n` Enter, Backspace → `# Title‸\n`
- `EB.hr.1` `---‸\n` Enter, Backspace → `---‸\n`
- `EB.fc.1` "```js\nlet x‸\n```\n" Enter, Backspace → "```js\nlet x‸\n```\n"
- `EB.tb.1` `x\n\n| a |\n| --- |\n| ‸1 |\n` →, →, →, Enter, Backspace → `x\n\n| a |\n| --- |\n| 1 |‸\n` · route `click cell 1` [D14]
- `EB.bl.1` `one\n\n‸\n\ntwo\n` Enter, Backspace → `one\n\n‸\n\ntwo\n`
- `EB.mk.1` `a **bold**‸\n` Enter, Backspace → `a **bold**‸\n` [U] [D34]
- `EB.hb.1` `red  \nblue‸\n` Enter, Backspace → `red  \nblue‸\n` [U] [D34]
- `EB.qc.1` `> alpha\nbeta‸\n` Enter, Backspace → `> alpha\nbeta‸\n` [U] [D34]
- `EB.sp.1` `alpha\nbeta‸\n` Enter, Backspace → `alpha\nbeta‸\n` [U] [D34]
```

### EF: end of file (R3, R30, R73, R83)
The leading suspect for the empty-line Backspace bug lives here. Each cell checks I3 with extra care: the caret must be drawn on the line that owns its offset, never left where the browser last had it.

```text
- `EF.1` `hello\n‸` x → `hello\n\nx‸` · route `click below` · drawn on the line under `hello` before the key; `x` starts its own paragraph there, where the caret was (R11, R99) [D2]
- `EF.2` `hello‸` Enter → `hello\n\n‸` [D1] [D2]
- `EF.3` `hello‸` Enter, Backspace → `hello‸` · Backspace on the empty line under a paragraph removes it and the blank line [U] [D2] [D34]
- `EF.4` `hello‸` Enter, Backspace, Backspace → `hell‸` [U] [D2] [D34]
- `EF.5` `hello\n‸` Backspace → `hello‸` · route `click below` [D2]
- `EF.6` `hello\n‸` ← → `hello‸\n` · route `click below` [D2]
- `EF.7` `hello‸\n` ↓ → `hello\n‸` · drawn on the empty line under `hello` [D2]
- `EF.8` `- a‸` Enter, Enter → `- a\n\n‸` [U] [D1] [D2]
- `EF.9` `- a‸` Enter, Enter, Backspace → `- a‸` · the second Enter leaves the list on an empty line under a blank line, and Backspace there removes that line and the blank line [U] [D2] [D34]
- `EF.10` `> a‸` Enter, Enter → `> a\n\n‸` [U] [D1] [D2]
- `EF.11` `# T‸` Enter, Backspace → `# T‸` [D2]
- `EF.12` `hello\n\n‸` Backspace → `hello‸` · route `click below` · the same place and bytes as after Enter in `EF.3`, so the same result (R18) [D2] [D34]
- `EF.13` "```js\nlet x‸" Enter, Backspace → "```js\nlet x‸" [D2]
- `EF.14` `‸` Enter, Backspace → `‸` · the empty file · route `click below` [D2]
- `EF.15` `al‸pha\n\n` Ctrl+End, Backspace → `alpha‸\n` · Ctrl+End lands on the drawn empty line [D11]
- `EF.16` `hello\n\n‸` Backspace, Backspace → `hell‸` · route `click below` · the first Backspace gives `hello‸`, as in `EF.12`, and the second takes `o` [D2] [D34]
```

### BS: Backspace (R30–R37)
```text
- `BS.p.1` `al‸pha\n` Backspace → `a‸pha\n`
- `BS.p.2` `‸alpha\n` Backspace → same
- `BS.p.3` `one\n\n‸two\n` Backspace → `one‸two\n` · the paragraphs join with no space, as `BS.pad.1` does [D34]
- `BS.sp.1` `alpha\n‸beta\n` Backspace → `alpha‸beta\n` · one word `alphabeta`
- `BS.hb.1` `red  \n‸blue\n` Backspace → `red‸blue\n` · the hard break and its spaces go [U]
- `BS.hb.2` "red\\\n‸blue\n" Backspace → "red‸blue\n" · the hard break and its backslash go [U]
- `BS.h.1` `# ‸Title\n` Backspace → `#‸Title\n` · prose `#Title`
- `BS.h.2` `one\n‸# Title\n` Backspace → `one‸# Title\n` · prose `one# Title`
- `BS.h.3` `###### ‸Title\n` Backspace → `######‸Title\n` · prose
- `BS.h.4` `# T‸itle\n` Backspace → `# ‸itle\n`
- `BS.hr.1` `---‸\n` Backspace → `--‸\n` · prose `--`
- `BS.q.1` `> ‸alpha\n` Backspace → `‸alpha\n` · no bar [D5]
- `BS.q.2` `> alpha\n> ‸beta\n` Backspace → `> alpha\n‸beta\n` · one quoted block `alpha beta` [D5]
- `BS.q.3` `> alpha\n> ‸\n` Backspace → `> alpha\n‸\n` · no bar beside the caret's line [D5]
- `BS.q.4` `> al‸pha\n` Backspace → `> a‸pha\n`
- `BS.qc.1` `> alpha\n‸beta\n` Backspace → `> alpha‸beta\n`
- `BS.li.1` `- ‸alpha\n` Backspace → `‸alpha\n` · a paragraph [D5]
- `BS.li.2` `- alpha\n- ‸beta\n` Backspace → `- alpha\n‸beta\n` · one item `alpha beta` [D5]
- `BS.li.3` `- alpha\n- ‸\n` Backspace → `- alpha\n‸\n` [D5]
- `BS.li.4` `- alpha\n‸beta\n` Backspace → `- alpha‸beta\n`
- `BS.li.5` `one\n‸- alpha\n` Backspace → `one‸- alpha\n` · prose `one- alpha`
- `BS.ol.1` `1. ‸alpha\n` Backspace → `‸alpha\n` [D5]
- `BS.ol.2` `10. ‸alpha\n` Backspace → `‸alpha\n` [D5]
- `BS.tk.1` `- [ ] ‸alpha\n` Backspace → `- ‸alpha\n` [D19]
- `BS.tk.2` `- [ ] alpha\n- [ ] ‸\n` Backspace, Backspace → `- [ ] alpha\n‸\n` [D19]
- `BS.nl.1` `- a\n  - ‸b\n` Backspace → `- a\n- ‸b\n` [D5]
- `BS.nl.2` `- a\n\t- ‸b\n` Backspace → `- a\n- ‸b\n` [D5]
- `BS.nl.3` `- a\n    - b\n        - ‸c\n` Backspace → `- a\n    - b\n    - ‸c\n` [D5]
- `BS.ql.1` `> - ‸alpha\n` Backspace → `> ‸alpha\n` [D5]
- `BS.ql.2` `> - alpha\n> - ‸\n` Backspace → `> - alpha\n> ‸\n` [D5]
- `BS.fc.1` "```js\nlet ‸x\n```\n" Backspace → "```js\nlet‸x\n```\n"
- `BS.fc.2` "```js\nlet x\n‸y\n```\n" Backspace → "```js\nlet x‸y\n```\n"
- `BS.fc.3` "```js\n‸let x\n```\n" Backspace → "```js‸let x\n```\n" · the opener's info string becomes `jslet x`, and the fence body is empty
- `BS.fc.4` "```js\nlet x\n```\n‸two\n" Backspace → "```js\nlet x\n```‸two\n" · the fence is unclosed through the end
- `BS.fu.1` "```js\nlet x‸" Backspace → "```js\nlet ‸"
- `BS.mm.1` "x\n\n```mermaid\nA-->B‸\n```\n" Backspace → "x\n\n```mermaid\nA-->‸\n```\n" · route `click diagram`, then the boundary
- `BS.tb.1` `| a | b |\n| --- | --- |\n| 1 | 2 |\n‸\n` Backspace, Backspace → `| a | b |\n| --- | --- |\n| 1 | 2 ‸\n` · the second press deletes the last `|` of the open table [D14]
- `BS.tb.2` `x\n\n| a | b |\n| --- | --- |\n| 1‸ | 2 |\n` Backspace → `x\n\n| a | b |\n| --- | --- |\n| ‸ | 2 |\n` · route `click cell 1`, then the boundary
- `BS.im.1` `![box](box.svg)‸\n` Backspace → `![box](box.svg‸\n` · the image line stays raw
- `BS.ii.1` `see «![box](box.svg)‸ here\n` Backspace → `see ‸ here\n` · route `drag` from just before the drawn image to just after it
- `BS.cm.1` `A {c1}x‸{/c1} B` + CM, Backspace → `A ‸ B\n\n` · the markers and the thread are gone
- `BS.cm.2` `See {c1}‸this{/c1} now.` + CM, Backspace → `See{c1}‸this{/c1} now.` + CM [D6]
- `BS.cm.3` `See {c1}this{/c1} ‸now.` + CM, Backspace → `See {c1}this{/c1}‸now.` + CM
- `BS.cm.4` `See {c1}this{/c1}‸ now.` + CM, Backspace → `See {c1}thi{/c1}‸ now.` + CM [D6]
- `BS.pad.1` `one\n\n‸two\n` Backspace → `one‸two\n` · the paragraphs join with no space, as `EB.p.3` does at the same place (R18) [U] [D34]
- `BS.pad.2` `red  \n\n‸blue\n` Backspace → `red‸blue\n` · the unseen spaces at the end of the first paragraph go too, so no hard break is made [D34]
- `BS.pad.3` `- alpha\n\n‸two\n` Backspace → `- alpha‸two\n` · the paragraph joins the item with no space, as `BS.pad.1` joins two paragraphs [D34]
- `BS.pad.4` `> alpha\n\n‸two\n` Backspace → `> alpha‸two\n` · the paragraph joins the quote with no space, as `BS.pad.1` joins two paragraphs [D34]
- `BS.mk.1` `a **bold**‸ b\n` Backspace → `a **bold*‸ b\n` · the unpaired marks are drawn
- `BS.mk.2` `a **‸bold** b\n` Backspace → `a *‸bold** b\n`
- `BS.st.1` `a ~~gone~~‸ b\n` Backspace → `a ~~gone~‸ b\n`
- `BS.lk.1` `a [text](https://x.test/p)‸ b\n` Backspace → `a [text](https://x.test/p‸ b\n`
- `BS.sel.1` `ab«cde‸f\n` Backspace → `ab‸f\n` · route `drag`
- `BS.sel.2` `ab‸cde«f\n` Backspace → `ab‸f\n` · route `drag` backward
- `BS.sel.3` `# Ti«tle\n- al‸pha\n` Backspace → `# Ti‸pha\n` · heading `Tipha` · route `drag`
- `BS.sel.4` `«- alpha\n- beta‸\n` Backspace → `‸\n` · route `drag`
```

### BG: Backspace on an empty line (R30)
This is the grid behind the reported bug. Every cell is decided by R30 `[U]`. The routes each cell runs are listed under Routes, and the expectation is the same for every route. Unless the cell's note says otherwise, the caret is drawn at the end of the line above, on that line's box, and the empty line is gone from the drawn page. The `BG.rep.1` cell runs in the burst pass P4, where its three Backspaces arrive faster than the hub replies.

Line above varies; the line below is `two`.

```text
- `BG.h-p` `# Title\n‸\ntwo\n` Backspace → `# Title‸\ntwo\n` · raw heading, drawn after `Title`; `two` stays a paragraph
- `BG.h6-p` `###### Title\n‸\ntwo\n` Backspace → `###### Title‸\ntwo\n`
- `BG.hr-p` `---\n‸\ntwo\n` Backspace → `---‸\ntwo\n` · raw `---`, drawn after the third dash
- `BG.fc-p` "```js\nlet x\n```\n‸\ntwo\n" Backspace → "```js\nlet x\n```‸\ntwo\n" · the fence is drawn as source, the caret after its closing backticks
- `BG.mm-p` "```mermaid\nA-->B\n```\n‸\ntwo\n" Backspace → "```mermaid\nA-->B\n```‸\ntwo\n" · the diagram is drawn as source [D14]
- `BG.im-p` `![box](box.svg)\n‸\ntwo\n` Backspace → `![box](box.svg)‸\ntwo\n` · the image line is raw, drawn after `)`; `two` is its own block [D21]
- `BG.bl-p` `one\n\n‸\ntwo\n` Backspace → `one‸\n\ntwo\n` · the second blank line goes, and the caret goes past the gap to the end of `one` (R7, R30); that a second blank line in a row is an empty line the caret can stop on is QA's proposal, not approved
- `BG.bof-p` `‸\ntwo\n` Backspace → same
```

The line above is `one`, or ends with `one`; the line below varies.

```text
- `BG.p-h` `one\n‸\n# Title\n` Backspace → `one‸\n# Title\n` · the heading stays a heading
- `BG.p-hr` `one\n‸\n---\n` Backspace → `one‸\n---\n` · the rule stays a rule
- `BG.p-q` `one\n‸\n> alpha\n` Backspace → `one‸\n> alpha\n` · the quote stays a quote
- `BG.p-li` `one\n‸\n- alpha\n` Backspace → `one‸\n- alpha\n` · the item stays an item
- `BG.p-ol` `one\n‸\n1. alpha\n` Backspace → `one‸\n1. alpha\n`
- `BG.p-fc` "one\n‸\n```js\nlet x\n```\n" Backspace → "one‸\n```js\nlet x\n```\n" · the fence stays a code block
- `BG.p-mm` "one\n‸\n```mermaid\nA-->B\n```\n" Backspace → "one‸\n```mermaid\nA-->B\n```\n" · the diagram stays drawn
- `BG.p-tb` `one\n‸\n| a |\n| --- |\n| 1 |\n` Backspace → `one‸\n| a |\n| --- |\n| 1 |\n` · the table stays a table
- `BG.p-im` `one\n‸\n![box](box.svg)\n` Backspace → `one‸\n![box](box.svg)\n` · the image stays its own block [D21]
- `BG.p-bl` `one\n‸\n\ntwo\n` Backspace → `one‸\n\ntwo\n`
- `BG.p-bl2` `one\n\n‸\n\ntwo\n` Backspace → `one‸\n\ntwo\n` · the empty line goes, the caret goes to the end of `one`, and the paragraphs stay apart [D34]
- `BG.p-bl3` `one\n\n‸\ntwo\n` Backspace → `one‸\n\ntwo\n` · the empty line between two paragraphs goes, and they stay two paragraphs; removing the blank line too would join them [D34]
- `BG.p-end` `one\n‸\n` Backspace → `one‸\n`
- `BG.p-eof` `one\n‸` Backspace → `one‸` · the empty line after the final newline [D2]
- `BG.p-eof2` `one\n\n‸` Backspace → `one‸` · the same place and bytes as after Enter at the end of `one`, so the same result as `EF.3` (R18) [D2] [D34]
```

Same construct above and below.

```text
- `BG.li-li` `- a\n‸\n- b\n` Backspace → `- a‸\n- b\n` · two items
- `BG.ol-ol` `1. a\n‸\n2. b\n` Backspace → `1. a‸\n2. b\n`
- `BG.nl-nl` `- a\n  - b\n‸\n  - c\n` Backspace → `- a\n  - b‸\n  - c\n`
- `BG.q-q` `> a\n‸\n> b\n` Backspace → `> a‸\n> b\n` · two quote lines under one bar
- `BG.h-h` `# A\n‸\n# B\n` Backspace → `# A‸\n# B\n`
- `BG.fc-fc` "```\na\n```\n‸\n```\nb\n```\n" Backspace → "```\na\n```‸\n```\nb\n```\n" · still two code blocks
- `BG.tb-tb` `| a |\n| --- |\n| 1 |\n‸\n| b |\n| --- |\n| 2 |\n` Backspace → `| a |\n| --- |\n| 1 |‸\n| b |\n| --- |\n| 2 |\n` · one table, open as source, whose body rows are `1`, `b`, `---`, and `2`
- `BG.fb-fb` "```\na\n‸\nb\n```\n" Backspace → "```\na‸\nb\n```\n" · an empty line inside a fence body
```

Lines drawn empty that are not (D16).

```text
- `BG.ws.1` `one\n\n‸ \n\ntwo\n` Backspace → `one\n‸\n\ntwo\n` · a line holding one space has one caret position, at its start; drawn on the first empty line [D16] [D17]
- `BG.ws.2` `one\n\n‸\t\n\ntwo\n` Backspace → `one\n‸\n\ntwo\n` · the same for a tab [D16] [D17]
- `BG.ws.3` `a  \n‸  \nb\n` Backspace → `a‸  \nb\n` · the line of spaces has one caret position, at its start; one block, `b` on its second visual line [D16] [D17]
- `BG.ws.4` `one\n\n‸  \n\ntwo\n` Backspace → `one\n‸\n\ntwo\n` · two spaces; the line still has one caret position, at its start [D16] [D17]
- `BG.rep.1` `one\n\n\n‸\ntwo\n` Backspace, Backspace → `one‸\n\ntwo\n` · the empty lines go one at a time, and the paragraphs stay apart [D34]
```

Files with `\r\n` (D18).

```text
- `CR.1b` "one\r\n\r\n‸two\r\n" Backspace → "one‸two\r\n" · no lone `\r`; the paragraphs join with no space, as `BS.pad.1` does [D18] [D34] (R7)
- `CR.2` "one‸\r\ntwo\r\n" Enter → "one\r\n\r\n‸two\r\n" [U] [D18]
- `CR.3` "‸one\r\n\r\ntwo\r\n" End → "one‸\r\n\r\ntwo\r\n" · three blocks: `one`, an empty line, and `two`; End stops before the `\r` [D17] [D18]
- `CR.4` "one\r\n\r\n‸\r\n\r\ntwo\r\n" x → "one\r\n\r\nx‸\r\n\r\ntwo\r\n" · `x` is its own block [D18]
- `CR.5` "one‸\r\ntwo\r\n" Delete → "one‸two\r\n" · Delete takes the pair, and no lone `\n` is left in a `\r\n` file [D18]
- `CR.6` "one‸\r\n\r\ntwo\r\n" Delete → "one‸two\r\n" · the paragraphs join with no space, as `DL.pad.1` does [D18] [D34]
```

### DL: Delete (R40, R41)
```text
- `DL.p.1` `al‸pha\n` Delete → `al‸ha\n`
- `DL.p.2` `alpha‸` Delete → same
- `DL.p.3` `one‸\n\ntwo\n` Delete → `one‸two\n` · the paragraphs join with no space, as `DL.pad.1` does [D34]
- `DL.sp.1` `alpha‸\nbeta\n` Delete → `alpha‸beta\n`
- `DL.hb.1` `red‸  \nblue\n` Delete → `red‸blue\n` · one line `redblue` · route `click red¦` [D15] [D35]
- `DL.hb.2` "red‸\\\nblue\n" Delete → "red‸blue\n" [D15] [D35]
- `DL.qc.1` `> alpha‸\nbeta\n` Delete → `> alpha‸beta\n`
- `DL.hr.1` `---‸\ntwo\n` Delete → `---‸two\n` · prose `---two`
- `DL.mm.1` "one‸\n```mermaid\nA-->B\n```\n" Delete → "one‸```mermaid\nA-->B\n```\n" · no diagram; the opener is prose
- `DL.im.1` `one‸\n![box](box.svg)\n` Delete → `one‸![box](box.svg)\n` · the image is drawn inside the paragraph
- `DL.ii.1` `see ‸![box](box.svg) here\n` Delete → `see ‸[box](box.svg) here\n` · a link `box`, no image
- `DL.mk.1` `a **bold‸** b\n` Delete → `a **bold‸* b\n` · the unpaired marks are drawn
- `DL.lk.1` `a ‸[text](https://x.test/p) b\n` Delete → `a ‸text](https://x.test/p) b\n` · no link
- `DL.bl.2` `‸\ntwo\n` Delete → `‸two\n` · routes `click`, `↑` [U] [D31]
- `DL.bl.3` `- a\n‸\n# Next\n` Delete → `- a\n‸# Next\n` · `Next` sits right under the item · routes `click`, `↓`, `↑` [U] [D31]
- `DL.bl.4` `# Title\n‸\n- a\n` Delete → `# Title\n‸- a\n` · routes `click`, `↓`, `↑` [U] [D31]
- `DL.h.1` `# Title‸\nmore\n` Delete → `# Title‸more\n` · heading `Titlemore`
- `DL.h.2` `one‸\n# Title\n` Delete → `one‸# Title\n` · prose `one# Title`
- `DL.li.1` `- alpha‸\n- beta\n` Delete → `- alpha‸- beta\n` · one item `alpha- beta`
- `DL.q.1` `> alpha‸\n> beta\n` Delete → `> alpha‸> beta\n` · one quote line `alpha> beta`
- `DL.fc.1` "```js\nlet x‸\ny\n```\n" Delete → "```js\nlet x‸y\n```\n"
- `DL.tb.1` `x\n\n| a |\n| --- |\n| ‸1 |\n` Delete → `x\n\n| a |\n| --- |\n| ‸ |\n` · route `click cell 1`
- `DL.cm.1` `See‸ {c1}this{/c1} now.` + CM, Delete → `See‸{c1}this{/c1} now.` + CM
- `DL.cm.2` `See {c1}this‸{/c1} now.` + CM, Delete → `See {c1}this‸{/c1}now.` + CM [D6]
- `DL.pad.1` `one‸\n\ntwo\n` Delete → `one‸two\n` · the paragraphs join with no space, as Backspace does from the other side (R18) [U] [D34]
- `DL.pad.2` `red‸  \n\nblue\n` Delete → `red‸blue\n` · the unseen spaces go too · route `click red¦` [D34]
- `DL.sel.1` `ab«cde‸f\n` Delete → `ab‸f\n` · route `drag`
- `DL.eof.1` `one‸\n` Delete → `one‸` · the final newline goes
- `EF.17` `one\n‸` Delete → same · route `click below` [D2]
```

### WB and WD: word delete (R50)
```text
- `WB.p.1` `alpha beta‸\n` Ctrl+Backspace → `alpha ‸\n` [D7]
- `WB.p.2` `alpha be‸ta\n` Ctrl+Backspace → `alpha ‸ta\n` [D7]
- `WB.p.3` `alpha ‸beta\n` Ctrl+Backspace → `‸beta\n` [D7]
- `WB.p.4` `‸alpha\n` Ctrl+Backspace → same
- `WB.sp.1` `alpha\n‸beta\n` Ctrl+Backspace → `‸beta\n` · the soft newline counts as a space [D7]
- `WB.h.1` `# Title‸\n` Ctrl+Backspace → `# ‸\n` · an empty heading [D7]
- `WB.li.1` `- alpha‸\n` Ctrl+Backspace → `- ‸\n` · an empty item [D7]
- `WB.mk.1` `a **bold**‸ b\n` Ctrl+Backspace → `a **bold‸ b\n` [D7]
- `WB.mk.2` `a **bold‸** b\n` Ctrl+Backspace → `a **‸** b\n` [D7]
- `WB.lk.1` `see [text](https://x.test/p)‸\n` Ctrl+Backspace → `see [text](https://x.test/p‸\n` [D7]
- `WB.cm.1` `See {c1}this‸{/c1} now.` + CM, Ctrl+Backspace → `See ‸ now.\n\n` · the comment and its thread are gone [D7]
- `WB.hr.1` `---‸\n` Ctrl+Backspace → `‸\n` [D7]
- `WB.fc.1` "```js\nlet foo‸\n```\n" Ctrl+Backspace → "```js\nlet ‸\n```\n" [D7]
- `WD.p.1` `‸alpha beta\n` Ctrl+Delete → `‸ beta\n` [D7]
- `WD.p.2` `al‸pha beta\n` Ctrl+Delete → `al‸ beta\n` [D7]
- `WD.p.3` `alpha‸ beta\n` Ctrl+Delete → `alpha‸\n` [D7]
- `WD.p.4` `alpha‸` Ctrl+Delete → same
- `WD.mk.1` `a ‸**bold** b\n` Ctrl+Delete → `a ‸bold** b\n` [D7]
```

### TB: Tab and Shift+Tab (R60–R62)
```text
- `TB.li.1` `- a\n- b‸\n` Tab → `- a\n\t- b‸\n` · `b` is drawn as a child of `a` [U] [D8]
- `TB.li.2` `- a\n- ‸b\n` Tab → `- a\n\t- ‸b\n` [U] [D8]
- `TB.li.3` `- a\n- ‸\n` Tab → `- a\n\t- ‸\n` [U] [D8]
- `TB.li.4` `- a\n\t- b‸\n` Shift+Tab → `- a\n- b‸\n` [U] [D8]
- `TB.li.5` `- a\n  - b‸\n` Shift+Tab → `- a\n- b‸\n` [U] [D8]
- `TB.li.6` `- a‸\n` Shift+Tab → same [U]
- `TB.li.7` `- a\n- b‸\n` Tab, Tab → `- a\n\t\t- b‸\n` [U] [D8]
- `TB.li.8` `- a\n«- b\n- c‸\n` Tab → `- a\n\t«- b\n\t- c‸\n` · route `drag` [U] [D8]
- `TB.ol.1` `1. a\n2. b‸\n` Tab → `1. a\n\t1. b‸\n` · `b` starts a new level [U] [D4] [D8]
- `TB.ol.2` `1. one\n2. two\n\t1. a‸\n` Enter, Shift+Tab → `1. one\n2. two\n\t1. a\n3. ‸\n` · an outdented item takes the next number at its new level [D4] [D8]
- `TB.ol.3` `1. one\n\t1. a\n\t2. b\n\t\t1. x‸\n` Enter, Shift+Tab → `1. one\n\t1. a\n\t2. b\n\t\t1. x\n\t3. ‸\n` · the same, one level down [D4] [D8]
- `TB.ql.1` `> - a\n> - b‸\n` Tab → same [D8]
- `TB.en.1` `- a‸\n` Enter, Tab, x → `- a\n\t- x‸\n` · the common way to start a child item [U] [D8]
- `TB.p.1` `al‸pha\n` Tab → `al\t‸pha\n`
- `TB.p.2` `al«ph‸a\n` Tab → `al\t‸a\n` · route `drag`
- `TB.p.3` `al‸pha\n` Shift+Tab → same · `document.activeElement` is still inside the editor [D8]
- `TB.h.1` `# Ti‸tle\n` Tab → `# Ti\t‸tle\n`
- `TB.q.1` `> al‸pha\n` Tab → `> al\t‸pha\n`
- `TB.hr.1` `---‸\n` Tab → `---\t‸\n` · prose: `---` and a tab, no rule [D21]
- `TB.bl.1` `one\n\n‸\n\ntwo\n` Tab → `one\n\n\t‸\n\ntwo\n` · the line is a block holding a tab, not a blank
- `TB.fc.1` "```js\n‸let x\n```\n" Tab → "```js\n\t‸let x\n```\n"
- `TB.fc.2` "```md\n- ‸x\n```\n" Tab → "```md\n- \t‸x\n```\n" · a fence line is code, not an item [D8]
```

### MV: arrows, Home, End (R70–R74)
```text
- `MV.p.1` `al‸pha\n` → → `alp‸ha\n`
- `MV.p.2` `al‸pha\n` ← → `a‸lpha\n`
- `MV.sp.1` `alpha‸\nbeta\n` → → `alpha\n‸beta\n` · drawn after the joining space
- `MV.li.1` `one‸\n- alpha\n` → → `one\n- ‸alpha\n` [D9]
- `MV.li.2` `- ‸alpha\n` ← → `-‸ alpha\n` · the raw marker is stepped through
- `MV.li.3` `one\n- ‸alpha\n` ←, ←, ← → `one‸\n- alpha\n`
- `MV.h.1` `one‸\n# Title\n` → → `one\n# ‸Title\n` [D9]
- `MV.q.1` `one‸\n> alpha\n` → → `one\n> ‸alpha\n` [D9]
- `MV.hr.1` `one‸\n---\ntwo\n` → → `one\n‸---\ntwo\n` · raw `---` [D9]
- `MV.fc.1` "```js\nlet x‸\nlet y\n```\n" → → "```js\nlet x\n‸let y\n```\n"
- `MV.lk.1` `a ‸[text](https://x.test/p) b\n` → → `a [‸text](https://x.test/p) b\n`
- `MV.cm.1` `See {c1}this{/c1}‸ now.` + CM, ← → `See {c1}this‸{/c1} now.` + CM [D6]
- `MV.cm.2` `See ‸{c1}this{/c1} now.` + CM, → → `See {c1}‸this{/c1} now.` + CM [D6]
- `MV.mk.1` `‸a **bold** b\n` →, →, → → `a *‸*bold** b\n`
- `MV.im.1` `see ‸![box](box.svg) here\n` → → `see !‸[box](box.svg) here\n` · the image is drawn as source on the caret's line
- `MV.tb.1` `one‸\n| a |\n| --- |\n| 1 |\n` → → `one\n‸| a |\n| --- |\n| 1 |\n` · the table opens as source
- `MV.tb.2` `| a |\n| --- |\n| 1 |\n‸two\n` ← → `| a |\n| --- |\n| 1 |‸\ntwo\n` · the table opens as source [D14] [D21]
- `MV.tb.3` `x‸\n| a |\n| --- |\n| 1 |\n` ↓ → `x\n‸| a |\n| --- |\n| 1 |\n` · the table opens as source
- `MV.mm.1` "tw‸o\n```mermaid\nA-->B\n```\ntwo\n" ↓ → "two\n```mermaid\nA-->B\n```\ntw‸o\n" · the diagram stays drawn; both lines read `two`, so the same x is the same column
- `MV.mm.2` "x‸\n```mermaid\nA-->B\n```\ntwo\n" → → "x\n‸```mermaid\nA-->B\n```\ntwo\n" · the diagram opens as source
- `MV.av.1` `al‸pha\n\nalpha\n` ↓ → `alpha\n\nal‸pha\n` · one ↓ goes past the gap to the next paragraph, with the goal x (R7) [D10]
- `MV.av.2` `alpha\n\nal‸pha\n` ↑ → `al‸pha\n\nalpha\n` · one ↑ goes past the gap (R7) [D10]
- `MV.av.3` `- alpha\n\n- be‸ta\n` ↑, ↑ → on `- alpha` [D10]
- `MV.av.4` `al‸pha\n` ↑ → `‸alpha\n` [D10]
- `MV.av.5` `alpha‸\n` ↓ → `alpha\n‸` · drawn on the empty line under `alpha` [D2] [D10]
- `MV.av.6` `r‸ed  \nred\n` ↓ → `red  \nr‸ed\n` · the same block's second visual line; both read `red` [D10]
- `MV.av.7` LONG@5 + `\n` ↓, ↓ → later in the block · two visual lines down [D10]
- `MV.av.8` "```\nab‸cdef\n\nabcdef\n```\n" ↓, ↓ → "```\nabcdef\n\nab‸cdef\n```\n" · monospace, so the column is exact [D10]
- `MV.av.9` "```\nabcd‸ef\nab\nabcdef\n```\n" ↓, x, ↓ → "```\nabcdef\nabx\nabc‸def\n```\n" · typing ends the run of vertical moves, so the second ↓ starts from the caret's own column [D10]
- `MV.av.10` "```\nabcd‸ef\nab\nabcdef\n```\n" ↓, Backspace, ↓ → "```\nabcdef\na\na‸bcdef\n```\n" · so does Backspace [D10]
- `MV.av.11` "```\na‸bcdef\nab\nabcdef\n```\n" ↓, →, ↓ → "```\nabcdef\nab\nab‸cdef\n```\n" · so does a horizontal move [D10]
- `MV.sh.1` `‸hello fox\n` Shift+→, Shift+→ → `«he‸llo fox\n`
- `MV.sh.2` `‸hello fox\n` Shift+→, Shift+→, → → `hel‸lo fox\n`
- `MV.sh.3` `‸hello fox\n\nnext\n` Shift+↓ → `«hello fox\n\n‸next\n` · the selection reaches the next paragraph, past the gap (R7)
- `MV.sh.4` `‸hello fox\n` Ctrl+→ → `hello ‸fox\n` · the start of the next word [U] [D29]
- `MV.cw.1` `hello fox‸\n` Ctrl+← → `hello ‸fox\n` [U] [D29]
- `MV.cw.2` `hello‸ fox\n` Ctrl+→ → `hello ‸fox\n` · over the space to the next word [U] [D29]
- `MV.cw.3` `x **bo‸ld** y\n` Ctrl+→ → `x **bold** ‸y\n` · the markers are part of the word [U] [D29]
- `MV.cw.4` `alpha\n‸beta\n` Ctrl+← → `‸alpha\nbeta\n` · a soft newline counts as a space [U] [D29]
- `MV.cw.5` `hello ‸fox\n` Ctrl+→ → `hello fox‸\n` · no word after, so the end of the last word [U] [D29]
- `MV.cw.6` `‸don't stop\n` Ctrl+→ → `don't ‸stop\n` · the apostrophe is part of the word [U] [D29]
- `MV.cw.7` `x **bold** ‸y\n` Ctrl+← → `x ‸**bold** y\n` · drawn before `bold` [U] [D29]
- `MV.pad.1` `one\n\n‸two\n` ← → `one‸\n\ntwo\n` · from the start of a paragraph, ← goes to the end of the paragraph above, past the space [U] (R7)
- `MV.pad.2` `one‸\n\ntwo\n` → → `one\n\n‸two\n` · the caret goes past the space to the start of the next paragraph [U] (R7)
- `MV.pad.3` `‸one\n\ntwo\n` ↓ → `one\n\n‸two\n` · ↓ goes from line to line, past the space [U] (R7)
- `MV.pad.4` `one\n\ntwo‸\n` ↑ → `one‸\n\ntwo\n` · ↑ goes from line to line, past the space [U] (R7)
- `MV.ce.1` `al‸pha\n` Ctrl+End → `alpha‸\n` · the empty line after the final newline is drawn only once the caret is on it [D11]
- `MV.ce.2` `one\n\nal‸pha\n` Ctrl+Home → `‸one\n\nalpha\n` [D11]
- `MV.pg.1` `‸` + FILL PageDown → later in the file · I9's `Q` lands at that caret [D11]
- `MV.esc.1` `al‸pha\n` Escape → same · the focus stays in the editor [D11]
- `MV.lg.1` `‸` + URL + `\n` End → the end of its visual line · drawn inside the editor, at the end of the full first line, and `scrollX` stays 0; the `Q` goes in at the caret and starts the second line (R74, R99) [D11]
- `MV.qc.1` `one\n\n> ‸alpha\nbeta\n` ← → `one\n‸\n> alpha\nbeta\n` · the hidden `> ` is skipped [D17]
- `MV.hb.1` `red‸  \nblue\n` → → `red  \n‸blue\n` · the hidden spaces are skipped [D17]
- `MV.rtl.1` "של‸ום עולם\n" → → on `שלום` · drawn inside the line; the caret starts inside the word, because a click at the end of a right-to-left run can map to either end of it. The plan does not decide between visual and logical order in right-to-left text.
- `MV.he.1` `alpha be‸ta\n` Home, x → `x‸alpha beta\n` [D11]
- `MV.he.2` `al‸pha beta\n` End, x → `alpha betax‸\n` [D11]
- `MV.he.3` `- al‸pha\n` Home, x → `- x‸alpha\n` · Home stops after the marker first [D11]
- `MV.he.3b` `- al‸pha\n` Home, Home, x → `x‸- alpha\n` · the second Home goes before the marker [D11]
- `MV.he.4` `alpha\nbe‸ta\n` Home, x → `x‸alpha\nbeta\n` · Home goes to the start of the visual line, not of the source line [D11]
- `MV.he.5` `al‸pha\nbeta\n` End, x → `alpha\nbetax‸\n` [D11]
- `MV.he.6` `one\n\nal‸pha\n` Home, Backspace → `one‸alpha\n` · Home goes to the start of `alpha`, and Backspace there joins the paragraphs with no space, as `BS.pad.1` does [D11] [D34]
- `MV.he.7` `one\n# Ti‸tle\n` Home, Home, Backspace → `one‸# Title\n` [D11]
- `MV.he.8` LONG@200 + `\n` Home → the start of its visual line · the start of the visual line holding offset 200, which is not the start of the paragraph [D11]
- `MV.he.9` `r‸ed  \nblue\n` End, x → `redx‸  \nblue\n` · End stops before the hidden spaces [D11] [D17]
- `MV.he.10` `> al‸pha\n` Home, x → `> x‸alpha\n` · Home stops after the quote marker first [D11]
- `MV.he.11` WRAP@300 + `\n` Home → the start of its visual line · a later visual line of a paragraph whose source is filled to 77 columns; the caret is drawn at that line's start, and the `Q` appears there (R99) [D11] [D27]
- `MV.he.12` BIG@700 + `\n` Home → the start of its visual line · the same on one 1323-character line [D11] [D27]
- `MV.he.13` WRAP@300 + `\n` End → the end of its visual line · after the space the line wraps at, with the caret drawn at the end of that line; the `Q` goes in after the space and starts the next line with the word it joins (R74, R99) [D11] [D27]
- `MV.he.14` BIG@700 + `\n` End → the end of its visual line · the same on one 1323-character line [D11] [D27]
```

### CK: click (R80–R83)
The caret starts on `x`, so the target block is drawn rendered when it is clicked.

```text
- `CK.p.1` `‸x\n\nalpha beta\n` click `alpha be¦ta` → `x\n\nalpha be‸ta\n`
- `CK.mk.1` `‸x\n\na **bold** b\n` click `b¦old` → `x\n\na **b‸old** b\n` · after the block turns raw and shows `**`, the caret is still drawn before `o`
- `CK.mk.2` `‸x\n\na **bold** b\n` click `¦bold` → `x\n\na **‸bold** b\n`
- `CK.mk.3` `‸x\n\na **bold** b\n` click `bold¦` → `x\n\na **bold‸** b\n`
- `CK.mk.4` `‸x\n\na **bold** b\n` click `¦ b` (2nd) → `x\n\na **bold**‸ b\n`
- `CK.it.1` `‸x\n\na *em* b\n` click `e¦m` → `x\n\na *e‸m* b\n`
- `CK.co.1` "‸x\n\na `code` b\n" click `co¦de` → "x\n\na `co‸de` b\n"
- `CK.lk.1` `‸x\n\na [text](https://x.test/p) b\n` click `te¦xt` → `x\n\na [te‸xt](https://x.test/p) b\n` · the page does not navigate; `location.href` is unchanged
- `CK.h.1` `‸x\n\n# Title\n` click `¦Title` → `x\n\n# ‸Title\n`
- `CK.h.2` `‸x\n\n# Title\n` click `Title¦` → `x\n\n# Title‸\n`
- `CK.li.1` `‸x\n\n- alpha\n` click `¦alpha` → `x\n\n- ‸alpha\n`
- `CK.li.2` `‸x\n\n- alpha\n` click bullet → `x\n\n- ‸alpha\n`
- `CK.ol.1` `‸x\n\n12. alpha\n` click `¦alpha` → `x\n\n12. ‸alpha\n`
- `CK.q.1` `‸x\n\n> alpha\n` click `¦alpha` → `x\n\n> ‸alpha\n`
- `CK.q.2` `‸x\n\n> alpha\n` click bar → `x\n\n> ‸alpha\n`
- `CK.sp.1` `‸x\n\nalpha\nbeta\n` click the left half of the joining space → `x\n\nalpha‸\nbeta\n`
- `CK.sp.2` `‸x\n\nalpha\nbeta\n` click the right half of the joining space → `x\n\nalpha\n‸beta\n`
- `CK.hb.1` `‸x\n\nred  \nblue\n` click `red¦` → `x\n\nred‸  \nblue\n`
- `CK.bl.1` `‸x\n\none\n\n\ntwo\n` click the second empty line under `one` → `x\n\none\n\n‸\ntwo\n`
- `CK.hr.1` `‸x\n\n---\n` click rule → `x\n\n‸---\n` [D12]
- `CK.tb.1` `‸x\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n` click cell 2 → `x\n\n| a | b |\n| --- | --- |\n| 1 | ‸2 |\n` · the table opens as source
- `CK.tb.2` `‸x\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n` click table edge → `x\n\n‸| a | b |\n| --- | --- |\n| 1 | 2 |\n`
- `CK.im.1` `‸x\n\n![box](box.svg)\n` click image → `x\n\n«![box](box.svg)\n‸` · the whole line, including its newline, is selected, and the picture stays drawn
- `CK.mm.1` "‸x\n\n```mermaid\nA-->B\n```\n" click diagram → "x\n\n```mermaid\n‸A-->B\n```\n" · the diagram opens as source
- `CK.fc.1` "‸x\n\n```js\nlet y\n```\n" click `le¦t` → "x\n\n```js\nle‸t y\n```\n" · the fence lines appear and the caret is still drawn before `t`
- `CK.cm.1` `‸x\n\nSee {c1}this{/c1} now.` + CM, click `th¦is` → `x\n\nSee {c1}th‸is{/c1} now.` + CM
- `CK.nl.1` `‸x\n\n- a\n  - b\n` click `¦b` → `x\n\n- a\n  - ‸b\n`
- `CK.ql.1` `‸x\n\n> - alpha\n` click `¦alpha` → `x\n\n> - ‸alpha\n`
- `CK.ii.1` `‸x\n\nsee ![box](box.svg) here\n` click image → `x\n\nsee ‸![box](box.svg) here\n` · the line turns raw
- `CK.sh.1` `al‸pha beta\n` Shift+click `be¦ta` → `al«pha be‸ta\n` [D22]
- `CK.sh.2` `# Ti‸tle\n\n- alpha\n` Shift+click `al¦pha` → `# Ti«tle\n\n- al‸pha\n` [D22]
- `CK.tab.1` `‸x\n\na\tb\n` click the right half of the tab → `x\n\na\t‸b\n`
- `CK.tab.2` `‸x\n\na\tb\n` click the left half of the tab → `x\n\na‸\tb\n` · the left half of a tab means before it, as for any glyph (R80)
- `CK.tab.3` "‸x\n\n```\n\tlet y\n```\n" click the left half of the tab → "x\n\n```\n‸\tlet y\n```\n" · a tab at the start of a fence line
- `CK.mid.1` `«alpha‸ beta\n` middle-click `beta¦` → `alpha betaalpha‸\n` · route `drag`, which sets the primary selection [D20]
- `DD.1` `«alpha‸ beta\n` drag the selection to `beta¦` → ` betaalpha‸\n` · one edit · route `drag` [D20]
- `CK.eof.1` `‸x\n\nalpha\n` click below → `x\n\nalpha\n‸` · drawn on an empty line under `alpha` [D2]
- `CK.eof.2` `‸x\n\nalpha` click below → `x\n\nalpha‸`
- `CK.wr.1` `‸x\n\n` + LONG + `\n` click `ga¦mma` (9th) → `x\n\n` + LONG@197 + `\n` · a glyph on a later visual line of the wrapped paragraph
- `CK.ac.1` `‸x\n\n- first item\n- second item\n` dblclick `second`, click `fi¦rst` → `x\n\n- fi‸rst item\n- second item\n` · the add-comment button that the double-click brings up does not cover the item above; the click adds no comment
- `CK.ac.2` `‸x\n\none\n\ntwo\n` dblclick `two`, click `o¦ne` at the bottom of its glyphs → `x\n\no‸ne\n\ntwo\n` · the same over the paragraph above
```

### DC: double-click (R84)
```text
- `DC.p.1` `‸x\n\nhello fox two\n` dblclick `fox` → `x\n\nhello «fox‸ two\n`
- `DC.mk.1` `‸x\n\na **bold** b\n` dblclick `bold` → `x\n\na **«bold‸** b\n` · the block turns raw between the presses; the selection covers `bold` and is drawn over exactly `bold` [U]
- `DC.mk.2` `a **bold** b‸\n` dblclick `bold` → `a **«bold‸** b\n` · the block was raw before the first press [U]
- `DC.mk.3` `‸x\n\na ***both*** b\n` dblclick `both` → `x\n\na ***«both‸*** b\n` [U]
- `DC.mk.4` `‸x\n\na **bold** b\n` dblclick `bold`, X → `x\n\na **X‸** b\n` · once the caret leaves, `X` is bold [U]
- `DC.it.1` `‸x\n\na *em* b\n` dblclick `em` → `x\n\na *«em‸* b\n` [U]
- `DC.it.2` `‸x\n\na _em_ b\n` dblclick `em` → `x\n\na _«em‸_ b\n` [U]
- `DC.co.1` "‸x\n\na `code` b\n" dblclick `code` → "x\n\na `«code‸` b\n" [U]
- `DC.lk.1` `‸x\n\na [text](https://x.test/p) b\n` dblclick `text` → `x\n\na [«text‸](https://x.test/p) b\n` · no navigation [U]
- `DC.lk.2` `a [text](https://x.test/p) b‸\n` dblclick `test` → `a [text](https://«x.test‸/p) b\n` [U] [D13]
- `DC.h.1` `‸x\n\n# Title\n` dblclick `Title` → `x\n\n# «Title‸\n` [U]
- `DC.li.1` `‸x\n\n- alpha\n` dblclick `alpha` → `x\n\n- «alpha‸\n` [U]
- `DC.q.1` `‸x\n\n> alpha\n` dblclick `alpha` → `x\n\n> «alpha‸\n` [U]
- `DC.cm.1` `‸x\n\nSee {c1}this{/c1} now.` + CM, dblclick `this` → `x\n\nSee {c1}«this‸{/c1} now.` + CM [U]
- `DC.st.1` `‸x\n\na ~~gone~~ b\n` dblclick `gone` → `x\n\na ~~«gone‸~~ b\n` [U] [D13]
- `DC.p.2` `‸x\n\ndon't stop\n` dblclick `don't` → `x\n\n«don't‸ stop\n` [D13]
- `DC.p.3` `‸x\n\nsnake_case word\n` dblclick `snake_case` → `x\n\n«snake_case‸ word\n` [D13]
- `DC.p.4` `‸x\n\nalpha, beta.\n` dblclick `beta` → `x\n\nalpha, «beta‸.\n` [D13]
- `DC.p.5` `‸x\n\na    b\n` dblclick the third of the four spaces → `x\n\na  ‸  b\n` · no selection
- `DC.sp.1` `‸x\n\nalpha\nbeta\n` dblclick `beta` → `x\n\nalpha\n«beta‸\n`
- `DC.fc.1` "‸x\n\n```js\nlet foo = 1\n```\n" dblclick `foo` → "x\n\n```js\nlet «foo‸ = 1\n```\n"
- `DC.tb.1` `‸x\n\n| a | b |\n| --- | --- |\n| one | 2 |\n` dblclick `one` → `x\n\n| a | b |\n| --- | --- |\n| «one‸ | 2 |\n` · the first press opens the table, so the text moves before the second press [U]
```

### T3: triple-click (R85, D32)
```text
- `T3.p.1` `‸x\n\nhello fox two\nnext\n` tripleclick `fox` → `x\n\n«hello fox two\nnext‸\n` · the whole block, both source lines [U] [D32]
- `T3.h.1` `‸x\n\n# Title\n` tripleclick `Title` → `x\n\n# «Title‸\n` [U] [D32]
- `T3.li.1` `‸x\n\n- alpha\n` tripleclick `alpha` → `x\n\n- «alpha‸\n` [U] [D32]
- `T3.li.2` `‸x\n\n- one\n- two\n` tripleclick `two` → `x\n\n- one\n- «two‸\n` · one item is one block [U] [D32]
- `T3.fc.1` "‸x\n\n```js\nlet y\nlet z\n```\n" tripleclick `z` → "x\n\n```js\n«let y\nlet z‸\n```\n" · the fence body [U] [D32]
- `T3.sp.1` `‸x\n\nalpha\nbeta\n` tripleclick `beta` → `x\n\n«alpha\nbeta‸\n` · the whole block [U] [D32]
- `T3.q.1` `‸x\n\n> alpha\n` tripleclick `alpha` → `x\n\n> «alpha‸\n` [U] [D32]
- `T3.ac.1` `‸x\n\nalpha beta gamma\n` tripleclick `beta` at the top of its line → `x\n\n«alpha beta gamma‸\n` · the add-comment button that the second press brings up is not under the third press; the triple-click adds no comment [U] [D32]
```

### DG: drag (R86)
```text
- `DG.p.1` `‸x\n\nalpha beta\n` drag `al¦pha` to `be¦ta` → `x\n\nal«pha be‸ta\n`
- `DG.p.2` `‸x\n\nalpha beta\n` drag `be¦ta` to `al¦pha` → `x\n\nal‸pha be«ta\n`
- `DG.mk.1` `‸x\n\na **bold** b\n` drag `¦a` to `bo¦ld` → `x\n\n«a **bo‸ld** b\n`
- `DG.x.1` `‸x\n\n# Title\n\n- alpha\n` drag `Ti¦tle` to `al¦pha` → `x\n\n# Ti«tle\n\n- al‸pha\n`
- `DG.x.2` `‸x\n\n# Title\n\n- alpha\n` drag `Ti¦tle` to `al¦pha`, y → `x\n\n# Tiy‸pha\n`
```

### SX: selections (R90)
```text
- `SX.1` `ab«cde‸f\n` X → `abX‸f\n` · route `drag`
- `SX.2` `# Ti«tle\n\n- al‸pha\n` y → `# Tiy‸pha\n` · route `drag`
- `SX.3` `«alpha‸\n` Enter → `\n‸\n` · route `drag` [D4]
- `SX.4` `«one\n\ntwo‸\n` Backspace → `‸\n` · route `drag`
- `SX.5` `one «x\n\n| a |\n| --- |\n| 1 |\n\nt‸wo\n` Backspace → `one ‸wo\n` · route `drag`
- `SX.6` `ab«cde‸f\n` Delete → `ab‸f\n` · route `drag`
- `SX.7` `al‸pha\n\nbeta\n` Ctrl+A, x → `x‸` [D11]
- `SX.8` `al‸pha\n\nbeta\n` Ctrl+A, Backspace → `‸` [D11]
- `SX.9` `‸hello fox\n` Shift+→, Shift+→, x → `x‸llo fox\n`
- `SX.10` `«See {c1}th‸is{/c1} now.` + CM, Backspace → `‸{c1}is{/c1} now.` + CM · route `drag` · the highlight covers `is` [D6]
- `SX.11` `one\n\nalpha‸\n\ntwo\n` Shift+Home, Backspace, Backspace → `one‸\n\ntwo\n` · the second Backspace removes the emptied line, and the paragraphs stay apart [D11] [D34]
- `SX.12` `al‸pha\n` Ctrl+A, Backspace, x → `x‸` [D11]
```

### CB: clipboard (R91)
```text
- `CB.1` `al«ph‸a\n` Ctrl+C, End, Ctrl+V → `alphaph‸\n` [D11]
- `CB.2` `«a **bold**‸ b\n` Ctrl+X → `‸ b\n` · route `drag` · then Ctrl+V gives back `a **bold**‸ b\n`
- `CB.3` `«# T‸\n\nx\n` Ctrl+C, →, Ctrl+V → `# T\n# T‸\nx\n` · two level-1 headings · route `drag`
- `CB.4` `«al‸pha beta\n` Ctrl+C, End, Shift+←, Shift+←, Ctrl+V → `alpha beal‸\n` · route `drag` [D11]
- `CB.5` `«- a\n- b‸\n\n` Ctrl+C, ↓, Ctrl+V → `- a\n- b\n- a\n- b‸\n` · four items, one list · route `drag` [U]
```

### UR: undo and redo (R92)
```text
- `UR.1` `alpha‸\n` x, y, Ctrl+Z → `alpha‸\n` · `x` and `y` are one run [U] [D33]
- `UR.2` `alpha‸\n` x, Ctrl+Z, Ctrl+Shift+Z → `alphax‸\n`
- `UR.3` `alpha‸\n` x, Ctrl+Z, Ctrl+Y → `alphax‸\n`
- `UR.4` `alpha‸\n` x, Ctrl+Z, y, Ctrl+Shift+Z → `alphay‸\n`
- `UR.5` `- alpha‸\n` Enter, Ctrl+Z → `- alpha‸\n` · one undo removes the whole continuation
- `UR.6c` `one\n\n‸two\n` Backspace, Ctrl+Z → `one\n\n‸two\n` · the blank line comes back, drawn as the space again [U] (R7)
- `UR.7` `al«ph‸a\n` x, Ctrl+Z → `al«ph‸a\n` · route `drag`
- `UR.8` `‸x\n\na **bold** b\n` dblclick `bold`, X, Ctrl+Z → `x\n\na **«bold‸** b\n` [U]
- `UR.9` `| a |\n| --- |\n| 1 |\n‸\n` Backspace, Backspace, Ctrl+Z → `| a |\n| --- |\n| 1 |‸\n` [D14]
- `UR.10` `alpha‸\n` Ctrl+Z → same
- `UR.11` `hello‸` Enter, Ctrl+Z → `hello‸` · drawn at the end of `hello` [D2]
- `UR.g.1` `alpha‸\n` x, y, z, Ctrl+Z → `alpha‸\n` · one run [U] [D33]
- `UR.g.2` `al‸pha\n` x, y, ←, z, Ctrl+Z → `alx‸ypha\n` · ← ends the run, so only `z` is undone [U] [D33]
- `UR.g.3` `alpha‸\n` x, pause 1500 ms, y, Ctrl+Z → `alphax‸\n` · a pause over one second ends the run [U] [D33]
- `UR.g.4` `alpha‸\n` x, y, z, Ctrl+Z, Ctrl+Shift+Z → `alphaxyz‸\n` · redo replays the whole run [U] [D33]
- `UR.g.5` `al«ph‸a\n` x, y, Ctrl+Z → `al«ph‸a\n` · the replaced text belongs to the run · route `drag` [U] [D33]
- `UR.g.6` `alpha‸\n` x, y, Backspace, z, Ctrl+Z → `alphax‸\n` · Backspace ends the run [U] [D33]
```

### IM: composition (R93)
```text
- `IM.1` `- al‸pha\n` compose `´`, commit `é` → `- alé‸pha\n` · one rev; no edit is sent before the commit
- `IM.3` `# ‸Title\n` compose `~`, commit `ñ` → `# ñ‸Title\n`
```

### RD: another client reads the file (R95)
Each cell moves the caret, then has another client read the file. The redraw that follows must leave the caret where the person put it.

```text
- `RD.1` `al‸pha beta\n` Home, read → `‸alpha beta\n` · Home is the browser's own move [U]
- `RD.2` `al‸pha beta\n` End, read → `alpha beta‸\n` [U]
- `RD.3` `‸alpha beta\n` Shift+End, read → `«alpha beta‸\n` · a selection the browser made [U]
- `RD.4` `al‸pha beta\n` →, read → `alp‸ha beta\n` · a move the page made itself [U]
- `RD.5` `alpha be‸ta\n` read → same [U]
- `RD.6` `‸x\n\nalpha beta\n` dblclick `beta`, read → `x\n\nalpha «beta‸\n` [U]
```

### MS: several sessions (R94 to R98)
The page, A, holds the caret marked in the source. B, a second user who talks to the hub directly, and the agent act through the keys. Each cell starts the page from a fresh load of the cell's file. B joins only for the cells that use it.

```text
- `MS.1` `one\n\nal‸pha\n` agent: prepend "zero\n\n" → `zero\n\none\n\nal‸pha\n` · the caret keeps its place in the text [A]
- `MS.2` `al‸pha\n` agent: append "\nlast\n" → `al‸pha\n\nlast\n` [A]
- `MS.3` `al‸pha beta\n` agent: replace "beta" with "BETA" (refused) → same · the agent is told the span is held by qa-bot [A]
- `MS.4` `one\n\nal‸pha\n` x, agent: prepend "zero\n\n", y → `zero\n\none\n\nalxy‸pha\n` [A]
- `MS.5` `one\n\nal‸pha\n` x, agent: prepend "zero\n\n", Ctrl+Z → `zero\n\none\n\nal‸pha\n` · only A's own edit is undone [D25]
- `MS.6` `al‸pha\n\nbeta\n` B: click `be¦ta`, B: x, y → `aly‸pha\n\nbexta\n`; B → `alypha\n\nbex‸ta\n` [A]
- `MS.7` `al‸pha beta\n\ntwo\n` B: click `tw¦o`, B: click `be¦ta` → same; B → `alpha beta\n\ntw‸o\n` · B sees the name qa-bot on alpha beta [T]
- `MS.8` `al‸pha\n\nbeta\n\ngamma\n` B: click `ga¦mma`, click `be¦ta`, B: click `al¦pha` → `alpha\n\nbe‸ta\n\ngamma\n`; B → `al‸pha\n\nbeta\n\ngamma\n` · B no longer sees the name qa-bot on alpha [T]
- `MS.9` `al‸pha\n\nbeta\n` x, B: click `be¦ta`, B: y, Ctrl+Z → `al‸pha\n\nbeyta\n`; B → `alpha\n\nbey‸ta\n` · A's undo leaves B's edit [D25]
- `MS.10` `one\n\nal‸pha\n` agent: comment "one" → at `al‸pha` · the comment's markers wrap `one` [A]
- `MS.11` `al‸pha beta\n` agent: comment "beta" (refused) → same [A]
- `MS.12` `al‸pha\n` reconnect, x → `alx‸pha\n` · the caret and the next key survive the dropped socket [A]
- `MS.13` `al‸pha\n\nbeta\n` B: click `be¦ta`, reconnect, x → `alx‸pha\n\nbeta\n`; B → `alxpha\n\nbe‸ta\n` · after A reconnects, each page still holds its own block [T]
- `MS.14` `one\n‸\n\n\ntwo\n` B: click the third empty line under `one`, Backspace → `one‸\n\n\ntwo\n`; B → `one\n\n‸\ntwo\n` · B's caret stays on its own line inside the run of blank lines [A]
- `MS.15` `one\n\nal‸pha\n` offline, agent: prepend "zero\n\n", online, x → `zero\n\none\n\nalx‸pha\n` · the edit made while A was away moves A's caret with its text [A]
- `MS.16` `one\n\n‸two\n` B: click `o¦ne`, Backspace → same; B → `o‸ne\n\ntwo\n` · joining `two` to the paragraph B is in is refused, and A sees the name qa-two flash on one [D26]
```

### WK: walking the caret (R1, R70, D6, D14, D17)
Each cell walks the caret from the start of the file to where → stops. These check that every offset the caret can rest at has one drawn place.

```text
- `WK.1` `‸one\n\ntwo\n` walk → `one\n\ntwo\n‸` [D2]
- `WK.2` `‸red  \nblue\n` walk → `red  \nblue\n‸` · never between the hidden spaces [D2] [D17]
- `WK.3` "‸red\\\nblue\n" walk → "red\\\nblue\n‸" · never after the hidden backslash [D2] [D17]
- `WK.4` `‸See {c1}this{/c1} now.` + CM, walk → "See {c1}this{/c1} now.\n‸\n```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nNote.\n```\n" · never inside a marker; the walk stops on the blank line before the hidden thread and does not enter it [D6]
- `WK.5` `‸x\n\n| a |\n| --- |\n| 1 |\n\ny\n` walk → `x\n\n| a |\n| --- |\n| 1 |\n\ny\n‸` · the table opens as the caret enters it [D2] [D14]
- `WK.6` `‸a  \n  \nb\n` walk → `a  \n  \nb\n‸` · the line of hidden spaces has one stop [D2] [D16] [D17]
- `WK.7` "‸x\n\n```mermaid\nA-->B\n```\n\ny\n" walk → "x\n\n```mermaid\nA-->B\n```\n\ny\n‸" · the diagram opens as the caret enters it [D2] [D14]
```
