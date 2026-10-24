# Editing
What the page and the hub do when a person edits a document. The first five sections are the model the page and the hub share. Each is met in that model, not by a special case in the key handler. Expected behavior, after them, lists what each key and click does.

A number in parentheses, such as (R74), names the rule in `qa/editor-matrix-test-plan.md`, where the cells that check it are listed. The two files hold the same rules, and a change to a rule in one is made in the other. A D number names a default in that plan. A default or a reading marked not approved is QA's proposal, and the owner has not approved it.

## An edit always gets an answer
When an operation leaves the text unchanged, the hub answers it with `{type:"noop", path, rev}`. The rev stays. The document is not broadcast. Undo and redo on an empty stack use the same answer. They do not return 409.

The page clears the edit waiter on `noop` the same way it clears it on its own `doc`. It does not send a backspace at offset 0 or a delete at the end of the text. When no `doc`, `noop`, or error has arrived for an edit after 2 seconds, the page drops the waiter, drops the queued edits, and opens the file again.

## The hub {c14}decides what a key changes{/c14}
The page sends the key, such as a letter, Backspace, or Delete, and the hub works out which text changes. A paragraph, a list item, a blank line, and the other parts of a document can each be held by one person at a time, while that person edits there.

A key is accepted when the text it changes is in a part this person holds, or in a part nobody holds. That stays true when the change reaches past the caret's own part into a free neighbor, for example when Backspace at the start of a line joins it to the line above. A key that would change a part another person holds is refused, the text stays as it was, and that person's name flashes on the part (D26).

The page does not guess ahead of time which parts a key will touch. It holds the part the caret is in, and the hub settles the rest when the key arrives.

## One caret
The page keeps the caret in `state`, and the browser keeps the DOM selection. `selectionchange` copies the DOM selection into `state`, except while `placeCaret` is writing it. `placeCaret` runs after this client's edit and after a `file` or `doc` that changes the text. A `locks` message redraws the text and leaves the DOM selection where it is.

Home, End, Shift+Home, Shift+End, and composition update the caret through that path. The page does not grow a handler for each of those keys.

## Every offset has one DOM point
`pointFor` returns a point for every offset from 0 through the length of the text. `mapOffset` of that point returns the same offset.

A caret does not sit inside a hidden marker. Comment markers and hard-break spaces are skipped. The point for an offset inside one of them is the visible side of that marker, and reading it back returns that visible offset. A closed table or diagram takes the caret before the atom or after it. The offset past the final newline has a point, and deleting the last character of the last line leaves the caret on that point.

A test places every offset of a fixed set of documents, reads the selection back, and requires the same offset.

## A gesture keeps the layout it started on
The block stays rendered until the pointer is released. The word under the first press is the word the double-click selects. The add-comment button sits clear of the selection and takes the primary button only.

The add-comment button's top edge is a half line under the lowest edge of the selection highlight, and across, it sits at about the last selected character (R108). It comes after any selection that can take a comment, however the selection was made (QA's reading, not approved). In that place it covers part of the text under the highlight's last line, near that character, and a press there lands on the button. The line above and the selection's own line stay clear. The button stays off comment cards, and moves sideways to clear one (not approved). When its place is not inside the window, the page makes room for the button there. The page extends so that the person can scroll to the button, and it need not scroll there by itself. Only if there is really no room, and the page cannot be extended, does the button go above the highlight. `browser/comments.browser.js` tests the placement, with the tolerances QA reads into it.

## Expected behavior
This lists what the page should do for each key and click, not what it does today.

### The rule for the whole page
- Text appears where the caret is when keys are pressed. A typed character is drawn where the caret was drawn just before the key (R99). After spaces typed at the end of a line, the caret is drawn after them, though two trailing spaces are a hidden line break marker (D17). The character then wraps as normal text does, so at the end of a line that wraps it goes in at the caret and can start the next line. A picture pasted inside a block is drawn after that block, and that block is not split. That paste is the exception (R91).

### What is drawn
- Only the block holding the caret is raw and shows its markdown source. Every other block is drawn rendered. Hard-break markers stay hidden even in the raw block, and so does the `>` on the later lines of a quoted paragraph (R1).
- Markdown syntax is not visible, and no space is held for it, until its block is the current one. A list item's bullet or number is drawn in the gutter left of its text, raw or not, so the text does not move when the item turns raw (R6).
- A single newline inside a paragraph is drawn as a space (R31). A blank line separates blocks.
- {c1}In formatted text, the space between paragraphs is padding, not an empty line. The blank line stays in the raw markdown, and there is no empty line between the paragraphs for the caret to land on (R7).{/c1} The last line of a paragraph is slightly padded to make visual room before the next line. There is no line between two paragraphs, so the caret cannot stop there: it goes from the last line of one paragraph to the first line of the next. Line behaviors stay as they are. `browser/paragraph-gap.browser.js` checks it.
- The caret can stop on any line that is not only markdown structure the renderer consumes. So it can stop on a line of only spaces or a tab between two paragraphs, at the line's start (D16). It cannot stop on the blank line between a fence, a table, a diagram, an image, or a rule and the block after it, which is space, as the blank between two paragraphs is.
- A table or a diagram opens as source while the caret is inside it, from its start through the end of its last line (R2, D14).
- A file that ends with a newline has an empty line after it, drawn while the caret is on it (R3, D2).
- A line that holds only an image is its own block. A line that does not start with `|` ends a table. A rule is exactly `---`, `***`, or `___` (R4, D21).
- A `\r\n` file is drawn and edited as if each `\r\n` were one newline, and every newline written into it is `\r\n` (R5, D18).

### Typing
- A typed character goes in at the caret, and the caret follows it. A selection is replaced by it (R10).
- The first character typed on the empty line after the final newline, under a paragraph, an item, or a quote, starts its own block (R11, D2). The same holds on any empty line directly under a paragraph, an item, or a quote, and at the start of a rule or a fence directly under one. A character, or a paste that does not already start with a newline, writes one newline first. A paste that starts with a newline does not gain another. A continuation line of a wrapped paragraph, item, or quote stays in that block. The implementer added these four sentences, and they are not approved. List items pasted on the empty line under a list join that list, with no newline first: nothing in a list pasted into another list says it should break off as a new list, a person who wants a new list makes one, and the page does what surprises the person least.
- Text from an input method is written once, at the caret, when the composition ends (R93).

### Enter
- On a list item, Enter starts a new item with the same marker, and the text after the caret moves to it. An ordered number goes up by one, and later items at that level are renumbered. A task item continues as `- [ ] ` (R20, D4, D19).
- On a quote line, Enter starts a new line with `> ` (R21).
- Enter on an empty item leaves the list. A top-level item loses its marker, a nested item moves out one level, and an empty quoted item becomes `> `. Enter on an empty `> ` line leaves the quote (R22).
- Inside a paragraph's text, Enter splits the paragraph in two, with one blank line between them, and the caret starts the second (R23).
- Text typed on the line Enter gives the caret is its own block. Where a single newline would join that line to a paragraph, an item, or a quote, Enter writes a blank line between them. So Enter at the end of a paragraph writes a blank line between the paragraph and the caret's line (R24, D1). In formatted text that blank line is padding, not a line (R7): the caret's line is drawn directly under the paragraph, and text typed there starts the new paragraph where the caret is (R99). The blank line under a paragraph, an item, or a quote takes no height, whatever follows it.
- Enter at the start of a block's text moves the block down one line, and the caret stays before the same character (R25, D3).
- {c2}Shift+Enter writes a hard break inside the block, so the text after the caret starts a new line in the same block (R26).{/c2} The caret goes to the start of that text: after the new line's `> ` in a quote, and after the indent in an item. The break is a backslash and a newline, with `> ` at the start of the new line in a quote, and Enter's behavior on a heading or in a fence (D28). The markdown has to stay valid, and its rendering has to read sensibly. With a word typed after the break, the file keeps the new line in the same block, and the rendered block draws it on its own line with no backslash. A line after a hard break belongs to the block above, so text typed there is not given a newline first. The page draws no backslash, in a quote too, and with nothing typed after the break. With nothing typed after the break, the file ends the block with the backslash, and other markdown viewers show it. QA's proposal for a clean form of that case is on ticket `acc28bfp`, not approved.
- In a fence, Enter writes one newline. On a line that starts with `|`, Enter writes one newline, so a table can be typed row by row (R27, R28, D4).
- Enter with a selection deletes the selection first (R29).

### Backspace
- On an empty line, Backspace removes the line, and the caret goes to the end of the line above. A line drawn empty counts, such as a line of spaces. At the start of the file it does nothing (R30, D16).
- Directly after a list, task, or quote marker, Backspace removes the marker. A task's `[ ] ` goes first. A nested item moves out one level instead (R32, D5, D19).
- Otherwise Backspace deletes the one character before the caret. A newline drawn as a space is such a character (R31).
- {c12}After a hard break, Backspace deletes the newline and the hidden trailing spaces or backslash with it, so the two lines join with nothing between them (R33).{/c12}
- A selection that covers exactly a table, a diagram, or an image deletes it whole (R34). With a picture line selected, Backspace and Delete each remove that line. The picture file stays while a session has the document open. A file that no image line names is removed when the last session closes the document.
- {c11}Backspace does the same thing at a place, whether the caret moved around or not. It is not an undo of Enter (R18).{/c11} On the empty line Enter leaves under a paragraph, Backspace removes that line and the blank line above it, and the caret goes back to the end of the paragraph. When another block follows that empty line, only the empty line goes, and the blank line above it stays, so the two blocks stay apart: with one, a blank line, an empty line, and two, Backspace on the empty line leaves the two paragraphs, with the caret at the end of one. Removing the blank line too would join them into one paragraph, drawn as one two. After Enter on an item or a quote line, Backspace removes one marker, as it does there anyway (R32). One Backspace does not take back Enter on an item, a quote line, or inside a paragraph. The markdown needs a blank line where the rendered text does not, so the page makes the changes the markdown needs, so that the rendered text makes sense to the person. Which places count is D34, not approved.
- At the start of a paragraph directly under another paragraph, Backspace joins the two with no space: the blank line between them and the newline both go. Delete at the end of the first paragraph does the same. So `he` and `llo` become `hello`, whether Enter split them or not. The person sees no space between the two paragraphs, so the join writes none, as a hard break joins its two lines directly (R18, R33, D34, not approved). The blank line under a list item or a quote has no height either, so QA proposes the same join there: Backspace at the start of two, under the item alpha, gives the item alphatwo (D34, not approved).

### Delete
- {c4}On an empty line, Delete removes that line, and the caret stays before the next line's text (R40).{/c4} Delete pulls the previous line up, and the page then copes with whatever that does to the markdown below it. In QA's reading (D31), the line under the empty one moves up into its place, with the caret at its start, and the page changes whatever else the markdown needs so every block keeps its kind. For example, `# Title\n‸\n- a\n` becomes `# Title\n‸- a\n`, the item right under the heading. Where removing the line would merge blocks, as in `- a\n‸\nnext\n`, where `- a\nnext` reads as one item, the file needs that blank line. QA proposes that the page draw it with no height and no caret stop, as R7 does between paragraphs (not approved).
- Otherwise Delete removes the one character after the caret. At the end of the file it does nothing (R41).
- When only hidden hard-break markers lie between the caret and the newline, Delete removes the newline and the markers, as the mirror of Backspace after a hard break (R42, D15, D35).

### Comments
- Emptying a comment's text removes the comment and its thread (R36).
- A comment marker is never cut, and the caret never rests inside one. Backspace, Delete, and word delete act on the character beyond the marker, and ← and → step over a whole marker (R37, R38, D6).
- A selection delete that takes one marker of a comment keeps the comment on what is left of its text (R39, D6).
- Delete on a comment's card removes the thread and both of its markers. The text stays, the caret keeps its place in it, and Ctrl+Z right after brings the thread back (R100, D30, not approved).
- No edit leaves a comment broken. Each comment opens once and closes once, it has its thread, and two comments never cross. That holds for typing, paste, drop, cut, and drag (R101, D30, not approved).
- Dragging a selection that holds a whole comment moves the comment with its text. A paste or a drop never writes a marker the file already has (R102, D30, not approved).
- A comment added over a whole list item, quote line, or heading opens after the line's marker, so the line keeps its kind (R103).
- The CLI cannot delete a thread whose text is in a block a person's caret holds. That is refused with 409 (R104).
- {c7}While the pointer is over a comment's highlight, each end of it is drawn as a rounded handle, in rendered and in raw text. Dragging a handle moves that end of the comment. In the raw block the markers are drawn as these handles, so the caret cannot aim inside them (R105).{/c7} This is how a person changes a comment's range. In the raw block, the end marker adds no space between the highlight's last character and the character after it. Whether the start marker may add space before the highlight is an open question on ticket `arh58dxz`.

### Word delete
- Ctrl+Backspace deletes back to the start of a group: first the spaces before the caret, then the run before them. A run is word characters, or other characters that are not spaces, so `**bold**` takes three presses. On an empty line it is Backspace. Ctrl+Delete does the same forward (R50, D7).

### Tab
- On a list item, Tab indents the item one level by writing a tab at the start of its line, and Shift+Tab outdents it. The caret keeps its place in the text. A top-level item does not outdent, and a quoted item does neither (R60, D8).
- An ordered item that starts a new level is numbered `1`. An ordered item that moves to a level where an item comes before it takes the next number after that item (R60).
- With a selection over several items, each item moves, and the selection keeps covering the same text (R60).
- Elsewhere, Tab writes a tab at the caret. Shift+Tab does nothing, and the focus stays in the editor (R61, R62).

### Moving the caret
- ← and → move one character as drawn, and hidden characters are skipped. Shift extends the selection. Alt with an arrow still moves one character (R70).
- {c3}Ctrl+← and Ctrl+→ move by word (R70).{/c3} Words are split at spaces, as a person would split them. Punctuation and markdown markers are part of the word they touch. The stops are the same in raw and in rendered mode. In QA's reading (D29), Ctrl+→ goes to the start of the next word, and Ctrl+← to the start of the word the caret is in, or of the word before. For example, `‸hello fox` with Ctrl+→ gives `hello ‸fox`, and `x **bo‸ld** y` with Ctrl+→ gives `x **bold** ‸y`.
- → at the end of a line lands after the next line's marker. ← at the start of a line lands at the end of the line above (R71, D9).
- An arrow never stops inside a closed image. Entering a table or a diagram opens it. ↑ and ↓ jump over a diagram (R72, D14).
- ↑ and ↓ move to the visual line above or below, and keep the x where the run of presses began. ↑ on the first line goes to the start of the file, and ↓ on the last line to its end (R73, D10).
- Home goes to the start of the line's text, after its marker, and a second Home goes to the very start of the line. End goes to the end of the line's text, before hidden trailing markers. Ctrl+Home and Ctrl+End go to the start and the end of the document (R74, D11, D17).
- Where a line wraps at a space, the space is not seen. End puts the caret after the line's last character, a space included, in raw and in rendered text. A character typed there goes in at the caret, like any typed character, and wraps as normal text does. So End goes after that space, the caret is drawn at the end of the line it was on, and a letter typed there wraps with the next word to the start of the next line (R74, R99). QA's reading, not the owner's: the hidden trailing markers of D17 are not drawn on the line, so End still stops before them. A click past the last word, and ↑ or ↓ toward the end of the line, are the part of D27 that is not approved.
- {c8}Where a line breaks inside a word, as a long URL does, End goes to the end of that full display line, and the caret is drawn there.{/c8} Under the rule above, End goes after the last character of that full line, and a letter typed there starts the next line.
- A line drawn empty has one caret position, at its start (D16).
- Escape changes nothing. PageUp and PageDown are the browser's own (R75, D11).

### Mouse
- A click puts the caret at the boundary under the pointer. The left half of a glyph means before it, and the right half means after it (R80).
- A click on a table cell opens the table with the caret at the start of that cell. A click on a picture that is the whole line selects that line, including the newline after it, and the picture stays drawn. A click on an inline image puts the caret at its start. A click on a diagram puts the caret at the start of its body. A click on a bullet or a quote bar puts the caret after the marker, and a click on a rule at the start of its line (R81, R82, D12).
- A pointer over a picture shows the comment anchor, and a plus button to its right. The plus opens that picture at the size of the window. A double-click on the open picture switches between fitting the window and the picture's own size. A glyph button at the upper right, or Escape, closes it and shows the document again.
- A click below the last line puts the caret at the end of the file (R83).
- A double-click selects the word under the pointer, without the markdown markers around it. On a run of spaces it selects nothing (R84, D13).
- {c5}A triple-click selects the block under the pointer, not one source line (R85).{/c5} The selection runs from after the first line's markdown marker to the end of the block's last line, without its newline, and covers a fence's body, not its fence lines (D32).
- A drag selects from the press to the release. No block turns raw until the release (R86, D12).
- Shift+click extends the selection (R87, D22).
- A middle-click pastes the primary selection where it clicks. Dragging selected text moves it (R88, D20).

### Selection, clipboard, and undo
- Typing replaces a selection, and Backspace and Delete delete it. Ctrl+A selects the whole file (R90).
- Copy and cut put the selected source on the clipboard as plain text. Paste inserts plain text at the caret (R91).
- A pasted or picked picture is stored beside the document and written as its own image line. Inside a paragraph, such as `alpha beta`, the paragraph stays whole and the image line follows it after a blank line. On the blank line between `alpha` and `beta`, that blank line becomes the image line, so the bytes are `alpha`, the image line, `beta`, with no extra blank line. The caret ends after the image line (R91). The picture is drawn at its intrinsic size.
- The page opens rendered. Raw is a selection for the document that is open, and nothing is stored. Another file, a reload, and a new tab start rendered. Raw draws every byte and does not interpret markdown, so a code fence has no syntax colors, and a click or a typed character inside a comment marker stays on that byte. The hub stores that character the same way the CLI's edit does. A rendered insert that cuts a marker is still refused. Comment cards stay up. The eye button stays fixed at the top right of the visible pane.
- Ctrl+Z undoes one step and puts the caret back where it was. Ctrl+Shift+Z and Ctrl+Y redo it (R92).
- {c6}A run of typing is one undo step.{/c6} A run works like this (R92, D33):
  - A run is typed characters, spaces included, each written right after the one before, with no other key, click, or edit by this page between them.
  - A run ends at a caret move by any key or click; at a key that is not a character, such as Enter, Backspace, Delete, Tab, or an arrow; at a paste, a cut, a drop, or a comment action; at Ctrl+Z or Ctrl+Y; at a pause of more than one second between keys; and at an edit by another session or an agent that lands in the run's block.
  - Typing over a selection starts a run, and the replaced text belongs to it.
  - Ctrl+Z undoes the whole run and puts back the bytes and the caret from before its first character. Ctrl+Shift+Z or Ctrl+Y redoes the whole run and puts the caret after its last character.
  - Undo still acts only on this session's own edits (R98). Text another session wrote inside the run stays after the undo.
  - Composed text from an input method joins the run as typed characters do, once it is committed (R93).
  - Each character is still sent to the hub as it is typed, so other sessions see it at once. Only the undo history groups it.
  - Examples: after `x`, `y`, `z` typed at the end of `alpha`, one Ctrl+Z gives `alpha`. After `x`, `y`, then →, then `z`, one Ctrl+Z removes only `z`. After `x`, a pause of 1.5 seconds, then `y`, one Ctrl+Z removes only `y`.
- Undo and redo act only on this session's own edits (R98, D25, not approved).

### Other sessions
- An edit by someone else moves the caret only when it lands before the caret, and the caret keeps its place in the text (R94).
- A redraw that changes no bytes, such as another client opening or reading the file, never moves the caret or the selection (R95).
- A block another session holds shows that user's name, and a click into it leaves the caret where it was (R96).
- When the hub refuses an edit because another session holds the span, the bytes and the caret stay. That session's name on the block flashes for about a second. With no holder, the caret's line flashes (R97, D26, the flash not approved).
- {c9}Two browser tabs are two sessions, even for the same user. A block one tab holds is refused to the other, which shows the user's own name on it (R96).{/c9}
- {c10}A file a session has open cannot be deleted. The CLI's delete and the page's Delete are refused with 409 and name that session's user. A rename or a move updates every session that has the file open: its address, its files list, and its title (R106).{/c10} A closed tab, or a page that is left, lets go of its file and its blocks at once. A rename or a move leaves every open session's caret where it was in the text (D37).

### Vim keys
With Vim keys off, the editor behaves as it does now: the rules above hold as written. With Vim keys on, the keys in Normal, Visual, and Visual Line do what vim does, as R110 to R122 say, where that differs from the rules above. Stock vim is the default unless the owner says otherwise. Where Obsidian's vim mode differs from stock vim, the owner decides. {c15}Shift+arrow in Normal moves the caret and leaves it collapsed{/c15}, where R70 extends the selection. Shift+→ and Shift+← move by a word, as `w` and `b` do in stock vim. Shift+↓ and Shift+↑ page down and up, as Ctrl-F and Ctrl-B do in stock vim. An Insert session, from entering Insert until Escape, {c16}is one undo, including a pause, Backspace, and Enter{/c16}, so the one-second cutoff of R92 does not apply during it. The owner prefers the undo of Obsidian's vim mode here, where one `u` undoes one operation. QA reads an arrow as ending an operation, so after `i`, `xx`, ↓, `yy`, Escape, one `u` takes back only `yy` (R109).

The document menu item Vim keys is off until it is checked. The browser remembers the choice for every document it opens, and stores it as `viewmark.vim`. The hub does not store it. A status beside that menu shows `N` for normal, `I` for insert, `V` for character visual, and `VL` for line visual. A count or an operator that is still waiting shows there instead of the letter. Normal and both visual modes draw a block caret. Insert keeps the thin caret (R110).

Escape, or Ctrl-[, leaves insert or visual and returns to normal. `i` inserts at the caret, `a` after the next character, `I` at the first non-blank of the vim line, `A` at the end of that line, and `gI` at the first column. `o` opens a line below and `O` a line above, then insert. In visual, `o` and `O` swap the ends of the highlight. `v` and `V` enter or leave those two visual modes, and each switches to the other. In insert, Ctrl-W or Command-W deletes the word before the caret, Ctrl-U deletes back to the start of the source line, Ctrl-T adds a leading tab, Ctrl-D removes one, and Ctrl-O runs one normal command and then returns to insert. Arrow keys in insert move and stay in insert. ↑ and ↓ in insert move one drawn row, as they do with vim keys off. In the other modes that W chord is taken and does not change the text, so it does not close the browser tab (R111).

A vim line in the formatted view is a rendered block. `j` and `k` move by that block, not by a source line and not by a wrapped row. A code fence is the exception: inside it, `j` and `k` move one line of code, and `V` selects lines of code, as in stock vim (g92jk6em). A paragraph is one line when it wraps, and a single newline inside it stays on that line. The blank between paragraphs is not a line, so `j` does not land there. `gj` and `gk` move by display row. `g0`, `g^`, and `g$` are that row's start, first non-blank, and end. In the raw view a vim line is one source line, and those `g` motions are `j`, `k`, `0`, `^`, and `$`. `w` can leave the line. `dw` and `cw` stop at the end of it. A linewise delete in the formatted view also takes the blank under the block. A linewise change leaves that blank and opens one empty line. `j` does not step onto the empty row after a final newline. `k` from that row returns to the last block (R112).

Comment markers and the tail of a hard break are skipped. The caret does not sit inside them. `r` and `~` change ordinary text on the vim line. A count that would include a line break or a comment marker changes nothing. Deleting one side of a comment keeps the comment on the text that remains. Deleting both sides takes the comment with the text (R113).

`gc` comments the highlight. In visual or visual line, `gc` on a highlight that is not already a comment adds one and opens an empty note. The mode stays visual or visual line until Ctrl-Enter or Command-Enter saves the note and returns to normal. A refused range, such as a highlight that is only a list marker, writes nothing and leaves the highlight. `gc` with the caret on an existing comment makes that thread current, and visual or visual line `gc` does the same when the highlight is already inside that comment. Then `r` replies, `R` resolves or reopens for the author of the first note, `X` deletes for that author, `Y` copies the link, and `i` opens the earliest note this session authored. Escape deselects the thread, discards an unsaved reply or revision, and normal navigation resumes. Normal `gc` off a comment does nothing. `c` is still change. In visual line, `R` still changes the highlighted lines. While a thread is current, `R` resolves or reopens for the first note's author instead. Elsewhere `R` is not replace mode (R114).

`y` and `p` use one unnamed register, which is not the clipboard. `"` does not select another register. `p` puts after the caret and `P` before it. A linewise register opens its own line. `]p` and `[p` put that line and then reindent it, as one edit. Ctrl-C copies a visual selection to the clipboard and stays visual. Ctrl-X cuts it and returns to normal. Ctrl-V pastes the clipboard. That paste works in normal, in visual, and in insert. There is no visual-block mode. `u` undoes in normal, and Ctrl-R redoes. Ctrl-Z undoes as well, including in visual, and Ctrl-Y and Ctrl-Shift-Z redo. In normal, `U` changes nothing. In visual, `u` and `U` change case. `.` in normal repeats the last change at the caret, and a count typed before `.` replaces the count stored on that change. There are no macros and no marks. Ctrl-A selects the whole file as a line visual selection (R115).

Search text is literal. `/` and `?` remember earlier patterns for the life of the page. That history is page memory. It is not stored in the document and it is not sent to the hub. Up-arrow recalls the previous pattern. Down-arrow walks back to the draft. Matches are painted while the pattern is typed and after Enter. `:noh` clears that paint and leaves the pattern, so `n` still repeats. `/` searches forward and `?` backward. Enter runs the line and Escape closes it. `n` and `N` repeat the search. `*` and `#` search the word under the caret as a whole word, and `g*` and `g#` search it without that limit. `gn` and `gN` select the next or previous hit. A search wraps once. No hit leaves the caret where it is (R116).

`w` and `W` are the same motion, and so are `b` and `B`, `e` and `E`, and `ge` and `gE`. A word runs until whitespace, so the punctuation it touches stays on it. Counts are typed before the command and stop at 10000. The digit `0` starts a count only after another digit. Alone, `0` is the first column (R117).

Motions are `h` `l` `j` `k` and the arrow keys, `0` `^` `$` `|`, `gg` and `G` with a count for a vim line, `w` `b` `e` `ge`, `f` `F` `t` `T` then `;` and `,`, `%` on brackets, `{` and `}` by block, and `H` `M` `L` for the top, middle, and bottom of the rows on screen. `+`, `-`, and Enter move by line and land on the first non-blank. `_` does that on the counted line, where 1 is the current line. Ctrl-F and Ctrl-B move by the rows on screen, and Ctrl-D and Ctrl-U move by half of them. `zz`, `zt`, and `zb` put the caret's line at the center, the top, or the bottom. `z.`, `z-`, and `z` followed by Enter do that and also move to the first non-blank. Ctrl-N and Ctrl-P are `j` and `k`. Home is `0`, End is `$`, Page Up is Ctrl-B, and Page Down is Ctrl-F. Space is `l` and Shift-Space is `w`. Backspace is `h` and Shift-Backspace is `b`. Delete is `x` (R118).

Operators are `d`, `c`, `y`, `>`, `<`, `=`, `gu`, `gU`, and `g~`. Doubled, they act on the vim line, and a count is that many lines. `D` and `C` run through the end of the line. `x` and `X` delete characters and stay on the source line, stopping before its newline. `s` deletes those characters and enters insert. In visual, `s` changes the highlight. `S` changes whole vim lines and enters insert. In visual line, `R` and `S` change the highlighted lines. While a thread is current, `R` resolves or reopens for the first note's author instead. Elsewhere `R` is not replace mode. `Y` yanks the line. `J` joins with a space and `gJ` joins without one. `r` replaces the following characters with the next key, and Enter as that key writes one line break for the whole count. `~` toggles case. `>` and `<` are a list indent, not a shift of spaces. `>` writes one leading tab, and an ordered item that starts a new level is numbered 1. On a line that is not a list item, `>` writes a tab at the start and `<` removes one leading tab. `=` changes a list item to one level under the item above, or to the top level when there is no item above, and it leaves any other line as it is. On a list item, `<<` lands on the item text. {c17}Tab and Shift-Tab in normal and visual are `>` and `<`.{/c17} The owner kept this on 2026-10-16. It differs from stock vim. In insert, Tab is the ordinary list indent, and Shift-Tab does what Tab does (R119).

Text objects follow an operator, or they extend a visual selection. They are a word (`iw`, `aw`), an inline code span (inner or around a backtick), a single or double quote that closes on the source line, a link label (`i[` and `a[`, or the same with `]`), and a block (`ip`, `ap`). `aw` takes the spaces after the word, or the spaces before it when none follow. `ip` stops before the block's own newline. `ap` also takes the blank lines after the block, or the blank lines before it when nothing follows (R120).

`:` opens a command line in normal. In visual it returns to normal and writes nothing. The names are `delete` (`d`), `join` (`j`), `yank` (`y`), `undo` (`u`), `redo` (`red`), and `substitute` (`s`). A shorter name works when it is a prefix of that word and at least as long as the short form. `%d` clears the document and yanks it as a line. Without `%`, delete, yank, and substitute use the source line, and join joins the way `J` does. `:s/old/new/` replaces the first literal `old` on that span. A final `g` replaces every match. `%s/old/new/g` covers the whole document. A slash inside a field is written `\/`. Any other range is refused, and an unknown command changes nothing (R121).

A vim edit is still an edit. A span another person holds is refused, the text stays, and that person's name flashes on the span (R122).

### Open choices
Each of these has been questioned. The page follows the rule above until the owner picks the other side.
- {c13}With text selected, an arrow key without Shift could collapse the selection to its edge, instead of moving one step on from the focus.{/c13} An example: in `alpha beta gamma`, select `beta` with a drag from left to right, so the selection's focus is after `beta`.
  - Today → moves one step on from the focus, to `alpha beta ‸gamma`, past the space. ← moves one step back from the focus, to `alpha bet‸a gamma`, inside what was selected.
  - The alternative, which browser text fields and most editors use: → puts the caret at the selection's right edge, `alpha beta‸ gamma`, and ← at its left edge, `alpha ‸beta gamma`, wherever the focus was. ↑ and ↓ start from that same edge.
  - With the same word selected from right to left, the focus is before `beta`. Today → gives `alpha b‸eta gamma` and ← gives `alpha‸ beta gamma`. The alternative gives the same two results as above.

```comment c1
:: 0
@2026-10-10T14:51:25.229Z Operator
That was suggested and acceptable for formatted text.  That helps resolve the 'how do I show the required blank line between paragraphs in raw markdown' issue.
```

```comment c2
:: 0
@2026-10-10T14:51:41.519Z Operator
Agreed.
```

```comment c3
:: 0
@2026-10-10T14:51:56.474Z Operator
Agreed
```

```comment c4
:: 0
@2026-10-10T14:56:13.672Z Operator
agreed
:: 1
@2026-10-10T15:23:10.875Z claude
Recorded as R40 in the Delete section here and in the plan. Where exactly the caret stays is QA proposal D31: at the start of what was the next line. The DL.bl cells now test it and fail today; ticket s7v532j5.

```

```comment c5
:: 0
@2026-10-10T14:56:45.327Z Operator
Agreed, even if this is contrary to earlier instructions.  It make more sense in the block-oriented world instead of line.
:: 1
@2026-10-10T15:23:10.938Z claude
Recorded as R85 in the Mouse section here and in the plan. Where the selection starts and ends is QA proposal D32: from after the first line's marker to the end of the block, and the body of a fence. The T3 cells now test it and fail today; ticket 2zjumyqu.

```

```comment c6
:: 0
@2026-10-10T14:57:30.397Z Operator
If you can document a clean, reviewed set of rules for this, yes.
:: 1
@2026-10-10T15:23:11.003Z claude
QA's proposed rules are under this item, and in the plan as D33, with example cells. R92 stays as it is until you approve them. Please review: when a run starts and ends, what Ctrl+Z and redo restore, and how other sessions and input methods fit in.

```

```comment c7
:: 0
@2026-10-10T14:59:31.411Z Operator
Interesting idea, I like it.  Make them draggable to move the comment block around.  Do the same in the rendered text.  When the cursor is over a comment highlight block, make each end of the block a rounded shape of some sort that can be clicked and dragged to move the comment block highlight around.
Please file an enhancement for this.

:: 1
@2026-10-10T15:05:40.230Z claude
Filed as enhancement `y8qvyrzz`, with acceptance criteria. It is R105 in the plan and sits under Comments here. It is also the answer to how a person changes a comment's range, the open question on `7e36kzm5`.

```

```comment c8
:: 0
@2026-10-10T15:01:12.999Z Operator
This deserves a more comprehensive question, please. 
:: 1
@2026-10-10T15:23:11.069Z claude
Rewritten here as a full question, with today's measured behavior, four options and their costs, and the option QA would choose. The same question is on ticket pg66fa4a.

:: 2
@2026-10-11T02:14:48.668Z claude
Answered on pg66fa4a: End goes to the end of the display line the caret is on. That is option C. The question left the open choices and is now a rule under End, with these markers on it. The plan has it under R74 and D27.

:: 3
@2026-10-11T02:22:21.234Z claude
Correction from QA. My note above said the owner chose option C. That went too far. The owner decided where End puts the caret: the end of the display line the caret is on. The owner has not decided where a letter typed on a full line appears. The rule above now says that the question is open on pg66fa4a, comment c2. 1092f59 had stopped I12 checking that case, and 492be29 reverts it.

:: 4
@2026-10-11T20:52:35.795Z Grok
Answered on pg66fa4a, note 5. End places the caret after the last character of the display line, in raw mode and in rendered mode, whether or not that character is a space. A typed character is inserted at that caret, and wrapping then lays the line out. The question is no longer open.

```

```comment c9
:: 0
@2026-10-10T15:02:16.715Z Operator
I'm assuming you mean browser tabs, and that's fine.  If you have two separate sessions they need to be treated as separate sessions for sanity regardless of a common user or not.
:: 1
@2026-10-10T15:23:11.133Z claude
Recorded in Other sessions here and in R96 in the plan. browser/two-tabs.browser.js tests it. It fails today: the second tab shows no name on the first tab's block, and after the first tab types, the second tab's caret lands in that block and its keys are refused. Ticket b88hgf6c.

```

```comment c10
:: 0
@2026-10-10T15:03:18.298Z Operator
Consider a file that's open 'locked' for delete.  Renames are harmless and the sessions need to update for the name and/or title change.
:: 1
@2026-10-10T15:23:11.196Z claude
Recorded in Other sessions here and as R106 in the plan; browser/file-life.browser.js tests it. A file a session has open already refuses delete, and a move or a title change already updates every session. Two things fail: a closed or reloaded tab keeps holding its file until the hub restarts (QA proposal D36: let go within 30 seconds; ticket jaqzc6n2), and a move puts the caret at the start of the file (QA proposal D37; ticket ewas7e44).

```

```comment c11
:: 0
@2026-10-10T15:03:44.626Z Operator
This makes sense - you can get rid of a single keystroke with a single keystroke.
:: 1
@2026-10-10T15:23:11.264Z claude
Recorded as R18 in the Backspace section here and in the plan. What counts as in between is QA proposal D34. The EB cells and EF.3, EF.4, and EF.9 now test it and fail today; ticket s6grmd59.

```

```comment c12
:: 0
@2026-10-10T15:03:58.791Z Operator
Correct.
:: 1
@2026-10-10T15:23:11.326Z claude
Recorded as R33 in the Backspace section here and in the plan. QA proposal D35 mirrors it for Delete before a hard break (R42). BS.hb and DL.hb now test both and fail today; ticket fwv62r4v.

```

```comment c13
:: 0
@2026-10-10T15:04:32.240Z Operator
This is too ambiguously worded, please clarify.  Examples would help.
:: 1
@2026-10-10T15:23:11.393Z claude
Rewritten with an example: the same selection, what each arrow key does today, and what it would do instead.

```

```comment c14 resolved
:: 0
@2026-10-10T15:08:56.706Z Operator
this is crap writing and jargon.
:: 1
@2026-10-10T15:25:52.099Z claude
Rewritten in plain words, as what a person can expect when a key reaches past the caret's own paragraph or item. The code names are gone. The heading now reads "The hub decides what a key changes". The four sections around it, "An edit always gets an answer", "One caret", "Every offset has one DOM point", and "A gesture keeps the layout it started on", are written the same way, from the implementer's point of view. Say if you want those rewritten too.

```

```comment c15 resolved
:: 0
@2026-10-16T13:47:28.128Z claude
For the owner: should Shift+→ and Shift+← in Normal move by a word, as stock vim does?

Today each moves one character. In stock vim 9.2, with no vimrc, Shift+→ from the start of `alpha beta gamma` lands on `beta`. This sentence came from the implementer's note c8.2 on 7vdep2z4. No note of yours records it.

:: 1
@2026-10-16T14:07:55.970Z Operator
Yes, harmless read-only, please add it.
```

```comment c16 resolved
:: 0
@2026-10-16T13:47:28.279Z claude
For the owner: should an arrow in Insert end the undo step, as it does in stock vim?

On the page, `i`, `xx`, ↓, `yy`, Escape, then one `u` takes back both `xx` and `yy`. In stock vim 9.2, with no vimrc, the same keys take back only `yy`, and a second `u` takes back `xx`. Enter and a pause do not end the step in either. This sentence came from the implementer's note c22.2 on 7vdep2z4. No note of yours records it.

:: 1
@2026-10-16T14:06:43.804Z Operator
Obsidian's is a bit friendlier, if that's feasible to do.
```

```comment c17 resolved
:: 0
@2026-10-16T13:47:28.410Z claude
For the owner: should Tab and Shift+Tab leave the text alone in Normal and Visual?

Today Tab indents the line and Shift+Tab outdents it. On 7vdep2z4 your note c3.0 says Tab does not belong in vim mode, and c25.1 asks that Shift+Tab do what vim does. In stock vim 9.2, with no vimrc, neither key changes the text in Normal. The implementer's later notes c25.5 and c26.0 record the indent and outdent as your decision. No note of yours records it.

:: 1
@2026-10-16T14:09:05.212Z Operator
Leave it in as-is, it's a variation but useful.
```
