# Architecture
Viewmark is a live markdown editor for a shared set of files. A single Node process holds every open document. The document is a single string, and the caret is an offset into that string. The page keeps a mirror of that string and redraws when the hub sends a `file` or `doc` message. The contenteditable region is how the browser reports a selection and a caret.

## The program
{c1}The server and the page are plain JavaScript modules. Nothing is loaded from npm.{/c1} Prism and Mermaid are files in `vendor/`, loaded by classic script tags in `index.html`.
* `src/doc.js` is the document model. It does not refer to `document` or `window`. It plans how each block should look, applies an edit to the string, computes the lock spans, plans a unified diff, and owns the comment rules.
* `src/editor.js` is the page. It paints that plan and sends edits to the hub. The test suite reaches the model through names this module re-exports. Nodes are built with DOM calls.
* `src/vim.js` matches a key when vim is on and returns the effect. It does not change the document itself. The page applies that effect and sends the edit to the hub.
* `src/session.js` is the browser's socket. After `hello` it asks for the repository list. It answers `ping` with `pong`.
* `src/hub.js` is the server side of a session. Incoming frames are handled one at a time on a single queue. The hub holds the open text, the block locks, and an undo stack and a redo stack for each socket.
* `src/ws.js` holds the RFC 6455 accept key, frame encoder, and frame parser. `src/ticket.js` is the ticket record, with no I/O. `server.js` listens on `node:http`, serves the page and raw files, and hands the WebSocket upgrade to the hub, which answers it. `cli.js` is a client that exits when its command finishes. `viewmark serve` starts the hub from that same program.

## The process
`start(port, stateDir)` listens on `127.0.0.1`. `viewmark serve` and `node server.js` default the port to 8765. The state directory contains `repos.json`. Viewmark does not treat that directory as a document root. If `repos.json` is missing, the registry is empty. When `start` is called with no state directory, it creates a temporary one and removes it on close.

`GET /` returns the page, with a `viewmark-build` meta added. Other `GET` paths serve files from the program directory, and a method other than `GET` or `HEAD` is 405. An ordinary `GET` of `/api/ws` is 400. The session is the WebSocket upgrade of that path. Client frames are masked. A message larger than 2 MiB closes the socket with 1009. The build hash includes `vendor/`, so when the hub restarts with a different build, an open page reloads itself.

`GET /raw/<name>/<file>` reads one file from the named repository, and only along a path that stays inside that repository. The hub reads a document the first time a command asks for it, and keeps that text until the document is deleted, its repository is deregistered, or the hub restarts. A write by another program to a document the hub holds stays invisible until then. The file list, the ticket list, and `/raw` read the disk each time.

## Repositories
A repository has a name, a description, and a directory. The name matches `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`. The description is trimmed, must be from 1 to 200 characters, and must not contain a carriage return, a line feed, or a tab. The path is stored as a realpath.

Register creates the directory when it is missing. An empty directory receives `welcome.md` and, when the sample exists, `tickets/seedmark.md`. The Viewmark source tree cannot be registered. A name that is already registered, or a directory that is already registered, is 409 and the registry is left unchanged. A directory that contains a registered root, or that sits inside one, is 400.

Deregister removes the registry entry and the in-memory file cache. The directory stays on disk.

A socket has no repository until it sends `{type:"repo", name}`. Until then, every document, comment, ticket, and attach frame is 400. Selecting the repository the socket already has selected does nothing. Selecting a different one drops the open document.

The page lists repositories in a select at the top of the file column. The visible text is the description, and the value is the name. A blank option stays selected until someone chooses a repository. The chosen name is kept in `sessionStorage` under `viewmark.repo`.

## Documents
The markdown is GitHub, GitLab, and Obsidian markdown. HTML is kept as characters in the string.

Away from the caret, a block is rendered. The block that holds the caret shows its source, including the characters that mark formatting. A table or a diagram that holds the caret opens into its source lines. The raw view, under The page, draws every block as source.

The page sends an operation, and the hub runs the same `doc.js` function on its own text to get a list of splices. When the hub accepts an edit, it writes the file by creating a temporary sibling and renaming it into place. It then broadcasts a `doc` message with the whole string, the rev, the actor, and `changes`, a list of `from`, `to`, and `inserted`. A single change also sets those three at the top level. A `locks` message follows.

Creating a document writes the message's `text`, or an empty file when there is none, at rev 0, and opens it for the caller. The path must end in `.md` or `.markdown`, and the CLI adds `.md` when it has neither. Paths are relative and use `/`. A path may not contain an empty segment, `.`, `..`, or `.git`. The file list includes only names that end in `.md` or `.markdown`. The `tickets` directory is left out of that list.

The list is a `docs` message, `{type:"docs", files, titles}`. A `{type:"list"}` frame returns the same shape. A create, a move, a delete, or an edit that changes the first-line heading broadcasts it. `files` is the array of markdown paths. `titles` maps a path to a label when the file's first line is a level-one heading: a hash, whitespace, then text. The pattern is `/^#\s+(\S.*)$/`, and the label is the captured text trimmed. A heading on a later line does not qualify, and neither does `##`, a hash with no space after it, or a hash with nothing after the space. Text already in the hub's cache is used before the bytes on disk. When a `docs` message has no `titles` field, every file is labeled with its filename. A directory is labeled with its own name. The path of the file stays as it is when the label changes.

`{type:"move", path, dir}` moves one listed file, or a directory that contains one. An empty `dir` means the top of the repository. A file keeps its basename, so a nested file moved to the top keeps its name and loses the parent directory. A directory keeps its name, so moving `notes` into `archive` produces `archive/notes`. A non-empty `dir` has to already be a directory that contains a listed file. The hub then applies these rules:

- If every destination path is the same as its source, the hub moves nothing. There is no error and no broadcast.
- If a destination is already in the cache or on disk, the answer is 409 and nothing is moved. Two sources that would write the same destination are the same 409.
- Moving a directory into itself, or into a descendant, is 400.
- `tickets`, and any path under it, is 400.
- A path that is not a listed file, or a directory of listed files, is 404.

The mover receives `{type:"moved", path, moves}`. A socket that has the moved path open receives a `file` message at the new path. The document's image directory moves with it, and an image line that names the old directory is rewritten, which raises the rev. The hub then broadcasts the new list.

On the page, file rows and directory rows can be dragged. A drop on a directory sends that directory. A drop on a file sends the directory that contains the file, which is empty when the file is already at the top. A drop on the tree's padding, rather than on a row, sends an empty `dir`. The page will not offer a directory as a drop target inside itself or inside a descendant. Ticket rows are left out of dragging.

During the drag, the tree shows where the row would land. A collapsed folder highlights that folder's row. An expanded folder, a file row, or the tree padding shows a line at the sorted position of the dragged name. The sort key is the filename or the directory name, rather than the heading used as a label. Releasing the pointer removes the mark. The message sent on drop is the one described above.

The file list and the ticket list each sit in a bordered box. The heading of the box is Files or Tickets, and the plus that creates a new item is on the right of that same line. The Files heading also has a delete button, and the Tickets heading has a filter button.

### Deleting
`{type:"delete", path}` removes a listed document and its image directory. If another socket has the document open, or holds a block in it, the answer is 409 with `heldBy`. The sender receives `{type:"deleted", path}`, and the repository receives a new `docs`. A delete is not an edit and has no undo. The page offers Delete file in the document menu and on the Files heading, behind a confirm dialog.

### Images
A picture is stored beside its document, in a directory named for it, and the document holds an image line that names it. `images.md` describes the design. Pasting or dropping a picture, or choosing Attach image in the document menu, sends `{type:"attach", path, cursor}` and then the bytes in one binary frame. The CLI's `attach` sends `start`, `end`, and `expect` instead of `cursor`. The hub accepts PNG, JPEG, GIF, or WebP up to 2 MiB. It inserts the image line as its own paragraph after the block that holds that point, as an ordinary edit with an undo entry. A picture that no line names is removed when the document's last session leaves it. The page loads pictures through `/raw/<repo>/<path>`.

### Comments
A comment is stored in the document string. The selection is wrapped by an opening marker and a closing marker that share an id, and a fenced block is appended for the thread. The id is the letter `c` followed by the smallest positive integer that is not already used. The fence's opening line is `comment` and that id. Resolving the thread writes `resolved` on the opening line only. The closing fence is left as it was.

Inside a fence, braces are ordinary characters. In the document text, a pair has this shape:

```
{c1}the selected words{/c1}
```

In the block that holds the caret, each marker is drawn as a rounded handle, and dragging a handle moves that end of the comment. In every other block the markers are omitted, and the words inside keep their inline formatting. The raw view draws the markers as characters. The thread is shown in the comment column. Resolved threads remain in the document and stay out of that column until show resolved is turned on. That switch is view state. It is a checkbox at the top of the comment column, and it is shown when a resolved thread exists.

A thread fence holds notes separated by `:: N` lines. Each note starts with `@<ISO time> <author>`. The hub writes the id and the author line.

### Code and diagrams
A fence whose info string is `mermaid` is drawn as a diagram. The page initializes Mermaid once: `startOnLoad` is false, `securityLevel` is `strict`, the theme is dark, flowchart labels are SVG, and Mermaid's own error graphic is suppressed. The fence body is rendered to an SVG. A failed render shows the source and the error text. While the caret is inside the fence, the page shows the source.

Every other fence is code. While the caret is outside the fence, each body line is passed to `Prism.tokenize`. The tokens become spans over those same characters, so the caret stays an offset into the document string. The page does not ask Prism to emit HTML. Grammars are included for markup, css, clike, javascript, typescript, python, bash, json, yaml, go, rust, sql, and mermaid. The short names `js`, `ts`, `py`, `sh`, `shell`, and `yml` select those grammars, and `html` and `xml` select markup. An unknown info string, or a tokenize result that does not rejoin into the original line, is left as plain code.

Updating Prism or Mermaid is a manual step: replace `vendor/prism.js` or `vendor/mermaid.min.js`, then reload the page.

## Collaboration
The username is a label supplied by the caller. Viewmark does not try to find out whether a person by that name exists.

The page asks for the name before it opens a socket, and keeps the accepted name in `sessionStorage` under `viewmark.username`. The command line takes `--user` or `VIEWMARK_USER`. When both are set, the flag wins. There is no default. An empty name is rejected, as is a name that contains a NUL, a carriage return, a line feed, `<`, or `>`. After `hello`, a frame whose username does not match the session is 403.

The hub pings every 15 seconds. The client answers with `pong`. Closing the socket releases its locks. A page socket carries a session token in `hello`, and the hub keeps its caret and its undo and redo stacks for the next `hello` with that token. A socket with no token, such as the CLI's, loses them.

A lock is the set of blocks the selection touches. A block is a prose paragraph, a blank line, a heading, a rule, an image line, a list item with its continuation lines, a whole fence, a table's header and delimiter, or one table row. Inside a comment fence, the opener, each note, and the closer are separate blocks. A `lock` frame claims every block from the anchor to the caret. An edit claims every block its splices touch, then keeps only the caret's block. If another socket holds one of those blocks, the hub returns `{type:"error", status:409, heldBy}` and leaves the file as it was. A stale `rev` is also 409. An accepted edit increments `rev`. On the page, the rev from the read ties a later edit to the text the caller saw. A CLI edit carries no rev, and the context lines of its diff do that job.

Undo and redo belong to the socket. Each stack holds at most 200 entries, stored as inverse operations. Undo is applied when the bytes still match and every block it touches is free or already held by that socket. Otherwise the answer is 409 and both stacks stay. An empty stack answers `noop`. The hub does not run snapshot undo against the shared string.

## Messages
The first frame is `hello`, with the username and, from the page, its session token. The hub answers `{type:"hello", build}`. Any other first frame closes the socket.

The page sends `repos`, `repo`, `open`, `create`, `move`, `delete`, `lock`, `edit`, `undo`, `redo`, `attach`, `tickets`, `ticket.create`, `ticket.set`, `ticket.delete`, `comment.reply`, `comment.edit`, and `pong`. The hub sends `repos`, `docs`, `tickets`, `file`, `doc`, `locks`, `noop`, `ticket`, `moved`, `deleted`, `error`, and `ping`. The CLI also uses `diff`, `rev`, `comment.threads`, `comment.add`, `comment.resolve`, `comment.delete`, and `ticket.purge`, which are answered by `rev`, `comments`, and `comment`.

`file` carries `path`, `rev`, `text`, `locks`, and, for a ticket, `ticket`. `locks` carries `lines`, a list of `{index, username, token}` where `index` is a block. A page that receives a `doc` whose rev is not one past its own opens the document again.

An edit from the page is `{type:"edit", op, path, rev, anchor, cursor}`. The op is insert, backspace, delete, move, comment.add, comment.save, comment.delete, or comment.resolve. An edit, undo, or redo that changes no bytes answers `{type:"noop", path, rev}` to the sender. The rev and the file stay, and nobody else hears a `doc`.

An error is `{type:"error", status}`. It adds `heldBy` when another user holds the span, and `reason` when the hub names one. A diff refused for its context or for a held span also carries `path`, `rev`, and `text`. Several matches is status 2 with reason `matches` and a count, and overlapping hunks are status 2 with reason `overlap`. A malformed frame, or a binary frame not preceded by `attach`, closes the socket.

## Files
The file the hub writes is the state. An accepted edit, create, attach, or ticket write replaces that file by creating a temporary sibling and renaming it into place. A move renames the file, and a delete removes it. Undo and redo stay in the hub's memory, with the socket or its session token. A restart keeps the files and drops those stacks. The hub does not keep another history.

## Tickets
A ticket is one markdown file, `tickets/<id>.md`, in the selected repository. The id is eight characters from `23456789abcdefghjkmnpqrstuvwxyz`, chosen by the hub. `ticket.create` is the only way to create a ticket. Creating a file under `tickets/` by any other command is 400.

The file is a header of eight lines, or nine when it names an assignee, then a blank line and a body. The editor opens the body. The header stays in the file and is not part of that text. An empty field is the key and a colon. A present field is the key, a colon, a space, and the value. Extra spaces around a value are ignored, but the space after the colon is required, so `priority:high` does not parse. Depends is a space-separated list of ticket tokens. A token is an id, or a repository name, a colon, and an id.

```
title: Sort the file list
state: new
type: task
priority: medium
parent:
depends:
reporter: Ada
created: 2026-04-02T15:04:05.006Z
```

The states are `new`, `triaged`, `in progress`, `blocked`, `pending review`, and `closed`. Any state may replace any other. The types are `bug`, `enhancement`, and `task`. An omitted type is stored as `task`. The priorities are `low`, `medium`, and `high`. An omitted priority is stored as `medium`. Any other priority, or a header that does not parse, is rejected and nothing is written. Parent is one ticket token, or empty. Depends is a set of tokens. A write whose parent or depends names the ticket itself, adds a missing ticket in a registered repository, or closes a cycle is 409. A stored link whose ticket is gone is dropped on the next write. State can change regardless of parent and depends.

`ticket.create` stores the body from the message. A missing body is stored as empty. A body that is present and is not a string is 400, and no file is written. `viewmark ticket create` reads stdin through to EOF when stdin is not a terminal, and it keeps every character, including a trailing newline. From a terminal, the body is empty.

Reporter is the username that created the ticket. Created is the hub's clock, in ISO-8601 UTC with milliseconds. Neither field can be changed. A `ticket.set` that includes either one is 400 and writes nothing.

A row in the narrow list shows the title. Hovering the ticket box widens the list to show the id, title, priority, assignee, state, and type. The title, state, type, priority, assignee, parent, and depends are edited in a form above the editor, and a changed field is saved when it changes. The id is shown with a copy button. The page does not send a type or a priority on create, so the hub stores `task` and `medium`.

The ticket box has a filter menu. The checkboxes are closed, low, medium, high, task, enhancement, and defect, in that order. Defect is the label for type `bug`. The value stored in the file remains `bug`. A checkbox that is off hides every ticket of that kind, including a ticket that is open in the editor. Closed starts off, so closed tickets stay hidden until that box is turned on. The other boxes start on. Show all, the last item in the menu, turns every box on. When a parent is hidden, its children are listed at the top level.

`ticket purge` deletes every closed ticket, clears parents that pointed at them, and drops those ids from depends. The page has no purge control.

On the wire, `type` is already the frame's command, so the ticket's type is sent as `ticketType`. Priority is sent as `priority`. The file header, the ticket record, the command line, the `tickets` list, and a file frame's `ticket` object call the field `type`.

## The command line
A command opens one socket to `127.0.0.1`, does its work, and exits. `--repo` is required for `list`, `show`, `create`, `edit`, `attach`, `delete`, `move`, `rev`, `comment`, and `ticket`, even when a single repository is registered. A `repo` subcommand rejects `--repo`. `--json` asks for the reply as JSON. `--port` and `VIEWMARK_PORT` default to 8765.

`edit` reads a unified diff on stdin, with an optional `--start LINE:OFFSET --end LINE:OFFSET` slice. A hunk's old lines must occur once in the slice. Zero matches exits 409 and writes nothing. Several matches or an overlap exits 2 and writes nothing. Each hunk is its own splice. `--rev`, `--find`, and `--replace` are rejected. The shell keeps eight bits of the status, so 400 is 144, 404 is 148, and 409 is 153.

`serve` stays running. It ignores `--user` and `VIEWMARK_USER`. With no directory argument, the state directory is `state` beside the program.

`ticket create` reads the body from stdin when stdin is not a terminal, as described under Tickets.

## The page
The page is three columns: a file column of 16rem, the editor, and a comment column of 20rem. At a width of 800 pixels and below, the columns stack in that order. When a ticket is open, its form sits above the editor. In the stacked layout, that form is between the file column and the editor. The theme is dark, and the page does not offer another one.

An eye button at the top right of the editor turns on the raw view, which draws every line as source. A red slash on the eye shows that raw is on. Raw is not stored, and it applies only to the document that was open when it was turned on. A key typed in raw is sent with `raw: true`, and the hub stores it as typed.

File and folder marks are 24 by 24 stroke icons ahead of the row's text. The text of a row is its label. The plus on the Files heading creates a markdown file. The plus on the Tickets heading creates a ticket.

### Vim keys
The document menu item Vim keys is off until it is checked. The browser stores that choice as `viewmark.vim`. The hub does not store it. While vim is on, the page asks `src/vim.js` which text a key changes, then sends that edit the same way it sends any other key. `src/vim.js` does not change the document itself.

`gc` comments the highlight. `gc` on an existing comment makes that thread current. A vim line in the formatted view is a rendered block. `y` and `p` use one unnamed register, which is not the clipboard. Ctrl-V pastes the clipboard. Search text is literal, and the hits are not drawn. The modes, the motions, and the rest of the differences from stock vim are the Vim keys section of `editing.md`.

```comment c1 resolved
How are syntax highlighting and mermaid diagrams done?
::
@2026-10-05T04:14:24.392Z Grok
Prism and Mermaid are files in `vendor/`, loaded by script tags in the page. The server does not install them from npm.

A fence is a diagram only when its info string is exactly `mermaid`. The page initializes Mermaid once: `startOnLoad` is false, `securityLevel` is `strict`, the theme is dark, flowchart labels are SVG, and Mermaid's own error graphic is suppressed. The fence body is rendered to an SVG. A failed render shows the source and the error text. While the cursor is inside the fence, the page shows the source, and leaving the fence draws the SVG again.

Every other fence is code. Each body line is passed to `Prism.tokenize`. The tokens become spans over those same characters, so the cursor stays an offset into the document string. The page does not ask Prism to emit HTML. Grammars are included for markup, css, javascript, typescript, python, bash, json, yaml, go, rust, sql, and mermaid. The short names `js`, `ts`, `py`, `sh`, `shell`, and `yml` select those grammars, and `html` and `xml` select markup. An unknown info string, or a tokenize result that does not rejoin into the original line, is left as plain code.
::
OK, copied into a vendor directory.  Updating it is a manual step then?
::
@2026-10-05T13:37:43.066Z Grok
Yes. The page loads `vendor/prism.js` and `vendor/mermaid.min.js` with script tags. Viewmark does not download a newer copy. Replace those two files, then reload the page.
::
@2026-10-05T13:42:45.803Z Operator
Snazzy!
```
