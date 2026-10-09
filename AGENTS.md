# Agents

Viewmark keeps each open document as one string in a single Node process. The cursor is an offset into that string. The hub is the only writer. The page and the CLI both talk to it. The README and `viewmark help` cover starting the hub and the shape of each command. This file is the contract those two leave out.

From this directory the command is `node cli.js`. The same program is `viewmark` once `cli.js` is on `PATH`.

## Memories

At the start of a session, read `ai/memories/MEMORY.md` and every memory it points to. Store memories only in `ai/memories/`, one file per memory, and keep one line per memory in `ai/memories/MEMORY.md`. Nothing else holds memories for this project.

## Editing documents

Pass `--user` and `--repo` on every document, comment, and ticket command. The username is the label stored on the edit. There is no default.

Read with `show`. The bytes are on stdout and `rev N` is on stderr.

`edit PATH` reads a unified diff on stdin. `--start LINE:OFFSET --end LINE:OFFSET` limits the slice. Both ends or neither. Lines count from 1. Offset counts from 0 and may equal the line length. The end is exclusive. A reversed pair is ordered. No range means the whole document. Out of range is 400 and writes nothing. `@@` numbers do not place a hunk. A hunk's old lines are the ` ` and `-` texts. No old lines is rejected. No hunks leaves the file as it was and does not open a socket. Zero matches exits 409 and writes nothing. Several matches or an overlap exits 2 and writes nothing. A change outside the slice does not reject the diff. `--rev`, `--find`, and `--replace` are rejected. Each hunk is its own splice, so unchanged text between hunks stays put. Another socket's span is 409 and names that user, and a comment range that overlaps a fence or a table or splits a comment is 409 and names that. A lock is a prose paragraph, a blank line, a heading, a list item, a fence, a table row, or a comment note. A quoted paragraph or item carries `>` on its first line only.

`create` reads the body from stdin when stdin is not a terminal. `--file PATH` reads that file instead. A path without a markdown suffix is stored with `.md` added. A path under `tickets/` is rejected. Use the ticket commands for those files.

Send the text of one comment note. The hub writes the note id and the author line. A reply goes through `comment reply`, not through `edit`. An agent leaves a question with `comment add PATH --start LINE:OFFSET --end LINE:OFFSET --expect TEXT` and the question on stdin. `--expect` is the bytes at that range. Lines count from 1. Offset counts from 0. The end offset is exclusive.

```
printf 'A correction.\n' | viewmark --user ada --repo notes comment reply welcome.md c1
```

`comment reply` takes the thread id and reads the note from stdin. `comment edit` requires `--expect`, the note text after the poster line, addresses one note by id, and uses the same username as the stored author. A mismatched `--expect` exits 409 and writes nothing. Edit a note that already has an author line. `comment list` and `comment show` print what is stored. A note whose text contains a line that is `::` or `::` plus a number is rejected. `--rev` on `comment edit`, `comment add`, and `comment reply` is rejected.

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

A ticket is `tickets/<id>.md`. `ticket create` reads the body from stdin. `ticket show` writes the body to stdout and the fields to stderr. Close one with `ticket set ID --state closed`. A field write uses the current body. Later field writes win. `--rev` is rejected. `ticket list` hides closed tickets until `--closed`.

## Changing this source

Node and git are the toolchain. There are no packages. From the repository root, `node --test` runs the suite and `node cli.js serve` starts the hub.

`src/doc.js` is the model: strings, offsets, and tokens. `src/editor.js` is the page and re-exports the names the editor tests call. `src/hub.js` stores the open files and publishes edits. `src/session.js` is the page socket. `cli.js` opens one socket, finishes the command, and exits. The page retries a dropped socket. The CLI stays one-shot.

The page builds the DOM with elements and text nodes. It prevents the browser's own input and applies the change to the string. A newline inserted on top of a newline is published after the following run of newlines. The lock for that edit covers every span the splice touches.

`index.html` on disk has no build meta. The server inserts `<meta name="viewmark-build">` when it serves the page. A later hello whose build differs from that meta reloads the page.

This repository tracks the program. `docs/` and `state/` are gitignored, and a docs directory is its own checkout, registered with the hub. Prism and Mermaid are the files in `vendor/`, loaded by the script tags in `index.html`.

The main branch is `master`. The words for lists of permitted and excluded things are whitelist and blacklist.

A glyph that a change does not specify exactly is a 24 by 24 stroke icon: viewBox `0 0 24 24`, no fill, stroke `currentColor`, stroke width 2, round caps and round joins, and `aria-hidden` on the SVG.
