# Agents

Viewmark keeps each open document as one string in a single Node process. The cursor is an offset into that string. The hub is the only writer. The page and the CLI both talk to it. The README and `viewmark help` cover starting the hub and the shape of each command. This file is the contract those two leave out.

From this directory the command is `node cli.js`. The same program is `viewmark` once `cli.js` is on `PATH`.

## Editing documents

Pass `--user` and `--repo` on every document, comment, and ticket command. The username is the label stored on the edit. There is no default.

Read with `show`. The bytes are on stdout and `rev N` is on stderr.

`edit PATH` reads a unified diff on stdin. `--start LINE:OFFSET --end LINE:OFFSET` limits the slice. Both ends or neither. Lines count from 1. Offset counts from 0 and may equal the line length. The end is exclusive. A reversed pair is ordered. No range means the whole document. Out of range is 400 and writes nothing. `@@` numbers do not place a hunk. A hunk's old lines are the ` ` and `-` texts. No old lines is rejected. No hunks leaves the file as it was and does not open a socket. Zero matches exits 409 and writes nothing. Several matches or an overlap exits 2 and writes nothing. A change outside the slice does not reject the diff. `--rev`, `--find`, and `--replace` are rejected. Each hunk is its own splice, so unchanged text between hunks stays put. Another socket's span is 409 and names that user, and a comment range that overlaps a fence or a table or splits a comment is 409 and names that. A lock is a prose paragraph, a blank line, a heading, a list item, a fence, a table row, or a comment note. A quoted paragraph or item carries `>` on its first line only.

`create` reads the body from stdin when stdin is not a terminal. `--file PATH` reads that file instead. A path without a markdown suffix is stored with `.md` added. On create, the hub lowercases each segment and turns every other character into a dash, and the command prints that stored path. A directory already stored under another spelling of that segment is reused, and the stored path uses that directory's name. Two such directories is 409. A spelling that normalizes to a document already stored is 409. A segment that is empty after that is 400. Move does not normalize a name, and a document already stored keeps its path. A path under `tickets/` is rejected. Use the ticket commands for those files.

Send the text of one comment note. The hub writes the note id and the author line. A reply goes through `comment reply`, not through `edit`. An agent leaves a question with `comment add PATH --start LINE:OFFSET --end LINE:OFFSET --expect TEXT` and the question on stdin. `--expect` is the bytes at that range. Lines count from 1. Offset counts from 0. The end offset is exclusive.

```
printf 'A correction.\n' | viewmark --user ada --repo notes comment reply welcome.md c1
```

`comment reply` takes the thread id and reads the note from stdin. `comment edit` requires `--expect`, the note text after the poster line, addresses one note by id, and uses the same username as the stored author. A mismatched `--expect` exits 409 and writes nothing. Edit a note that already has an author line. `comment list` and `comment show` print what is stored. A note whose text contains a line that is `::` or `::` plus a number is rejected. `--rev` on `comment edit`, `comment add`, and `comment reply` is rejected.

`comment resolve PATH ID` marks that thread resolved. `comment open PATH ID` clears it. `comment delete PATH ID` removes that thread's marks and its fence. The author is note 0's author, the `--user` of the command. Anyone else exits 403 and writes nothing. Already resolved or already open exits 0 and writes nothing. A missing path or thread exits 404. A span held by another socket exits 409 and names that user. `--rev` on those three is rejected. A reply on a ticket document stores the note, the author, and the time, in the same shape as a reply on any other document.

A thread is stored like this:

````
```comment c1
:: 0
@2026-10-05T16:00:00.000Z Ada
This note is the start of the thread.
:: 1
@2026-10-05T16:05:00.000Z Bea
A reply keeps its own author line.
```
````

Note 0 is the original. The next reply is one past the highest id. The prose marks the same id with `{c1}` and `{/c1}`. An id starts with a letter. A resolved thread opens with `comment c1 resolved`. `samples/welcome.md` is a complete example.

The markdown is the dialect named in the README. A fence whose info string is exactly `mermaid` is drawn as a diagram. Any other info string is source. Highlighted fences are markup, css, clike, javascript, typescript, python, bash, json, yaml, go, rust, sql, and mermaid. The short names js, ts, py, sh, shell, yml, html, and xml map to those. HTML in the prose is stored as text.

A ticket is `tickets/<id>.md`. `ticket create` reads the body from stdin. `ticket show` writes the body to stdout and the fields to stderr. The state is new, triaged, in progress, blocked, pending review, or closed. Close one with `ticket set ID --state closed`. A field write uses the current body. Later field writes win. `--rev` is rejected. `ticket list` hides closed tickets until `--closed`.

## Changing this source

Node is the toolchain. There are no packages. From the repository root, `node --test` runs the unit tests in `test/` and `node cli.js serve` starts the hub. The browser tests are separate, below.

`src/doc.js` is the model: strings, offsets, and tokens. `src/editor.js` is the page and re-exports the names the editor tests call. `src/hub.js` stores the open files and publishes edits. `src/session.js` is the page socket. `cli.js` opens one socket, finishes the command, and exits. The page retries a dropped socket. The CLI stays one-shot.

The page builds the DOM with elements and text nodes. It prevents the browser's own input and applies the change to the string. A newline inserted on top of a newline is published after the following run of newlines. The lock for that edit covers every span the splice touches.

Vim keys are a page mode, matched by `src/vim.js`. The page applies the effect and the hub still decides the edit. `gc` comments the highlight. `gc` on an existing comment makes that thread current. The README and `editing.md` list the keys, including the parts that are not stock vim.

`index.html` on disk has no build meta. The server inserts `<meta name="viewmark-build">` when it serves the page. A later hello whose build differs from that meta reloads the page.

This repository tracks the program. `docs/` and `state/` are gitignored. A docs directory is registered with the hub. Prism and Mermaid are the files in `vendor/`, loaded by the script tags in `index.html`.

The main branch is `master`. The words for lists of permitted and excluded things are whitelist and blacklist.

A glyph that a change does not specify exactly is a 24 by 24 stroke icon: viewBox `0 0 24 24`, no fill, stroke `currentColor`, stroke width 2, round caps and round joins, and `aria-hidden` on the SVG.

## Browser tests

`node --test` does not run the browser tests. They are the `browser/*.browser.js` files, and they drive the page in a real browser with real input events.

- `node --test browser/enter.browser.js` runs one file. `node --test --test-concurrency=3 browser/*.browser.js` runs them all, in about ten minutes in Chromium.
- `--test-name-pattern` picks tests by name. A cell is a test named by its id, so `--test-name-pattern='^SE\.q\.2$'` runs that cell, and `--test-name-pattern='^SE\.'` runs every Shift+Enter cell.
- A cell's file is the one whose `defineSuite` line lists the cell's prefix: `BG.` in `empty-line`; `BS.`, `DL.`, `WB.`, `WD.`, and `CR.` in `delete`; `MS.` in `sessions`; `CK.`, `DC.`, `T3.`, `DG.`, and `DD.` in `pointer`; `TB.`, `MV.`, `RD.`, and `WK.` in `tab-move`; `TY.` and `TC.` in `typing`; `EN.`, `SE.`, `EB.`, and `EF.` in `enter`; and `SX.`, `CB.`, `UR.`, and `IM.` in `selection`.
- They run in Chromium at `/usr/bin/chromium`, and `VIEWMARK_CHROMIUM` names another. `VIEWMARK_BROWSER=firefox` runs the same tests in Firefox, inside cage when cage is installed and headless otherwise.
- Each test starts its own hub on a free port, with its own state and repo directories, and removes them when it ends. It never writes to the live hub.
- The cell suites read their cells from `qa/editor-matrix-test-plan.md` in the `viewmark` repo of the running hub, so that hub must be up. `VIEWMARK_PLAN_PORT` names its port when it is not 8765.
- A ticket that names a test or a cell is not done until that test passes in Chromium and in Firefox. Run it in both before closing the ticket.
