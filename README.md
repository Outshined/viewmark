# Viewmark

Viewmark is specifically designed for interacting with agents across multiple projects. One hub holds the open documents. Each project is its own directory of markdown, registered by name. An agent uses the CLI to list, show, edit, comment, and file tickets. The browser shows those same documents to a person. Both see the same bytes.

The markdown is the dialect used by GitHub, GitLab, and Obsidian. A fenced block tagged `mermaid` is drawn as a diagram. HTML in the document is stored as text and is not rendered.

In the age of vibe coding, Viewmark is like a Pet Rock. This is my Pet Rock, and I'm quite pleased with it.

## Run

Viewmark needs Node and git. It has no packages to install.

From this directory:

```
node cli.js serve
```

The hub listens on `127.0.0.1:8765`. Its state directory defaults to `state` beside `cli.js`. To keep state somewhere else, pass that directory:

```
node cli.js serve /path/to/state
```

`--port` changes the port. `viewmark help` prints the commands and the exit codes. It does not need a running hub.

Open `http://127.0.0.1:8765/` and enter a name. That name is the label stored on edits, comments, and tickets. It is not an account, and it is not a password.

## Repos

A repo is a directory of `.md` and `.markdown` files. Register it once:

```
viewmark --user ada repo register --name notes --description "Lab notes" --path /home/ada/notes
```

Registration creates a git repository in that directory when `.git` is not already there. When that directory is empty, registration copies `welcome.md` and `tickets/seedmark.md` into it. Checkpoints are commits in that repository. Viewmark makes one about an hour after the last change, and also when you switch repos, when you run `commit`, and when the hub shuts down cleanly. It commits only inside the registered directory, and it will not commit a surrounding repository.

The Viewmark source tree cannot be registered as a repo. A directory that was registered without its own git repository is not initialized when the hub starts. Create the repository in that directory yourself.

## The page

The left side lists the files in the selected repo and the tickets for that repo. The center is the open document. A mermaid diagram is drawn while the caret is outside the fence. Click the diagram, or move into it, and the fence becomes source again.

Tickets are files under `tickets/` in the repo. The page can create one, edit its fields, and open it like any other document.

## The CLI

Document commands require `--user` and `--repo`. Add `--json` when a program will read the result. There is no default user name.

```
viewmark --user ada --repo notes list
viewmark --user ada --repo notes show welcome.md
printf 'Hello\n' | viewmark --user ada --repo notes create welcome.md
viewmark --user ada --repo notes edit welcome.md --rev 0 --find Hello --replace Hi
```

`show` prints the document on stdout and `rev N` on stderr. `create` reads the body from stdin when stdin is not a terminal. Pass `--file` to read a file instead. A path without a markdown suffix is stored with `.md` added. `edit` replaces one occurrence of `--find`. The rev must be the current rev, and the find text must occur once. A stale rev changes nothing.

You send the text of one comment note. The hub writes the note id and the author line.

```
viewmark --user ada --repo notes comment list welcome.md
printf 'A correction.\n' | viewmark --user ada --repo notes comment reply welcome.md THREAD
```

`comment edit` addresses one note by id and requires `--rev`. A reply does not take `--rev`.

Tickets use the same repo:

```
printf 'The door sticks.\n' | viewmark --user ada --repo notes ticket create --title "Map the door"
viewmark --user ada --repo notes ticket list
```

`ticket list` hides closed tickets unless you pass `--closed`. `ticket show ID` prints the body. `viewmark help ticket` and `viewmark help comment` describe the remaining flags.

## Tests

From the repository root:

```
node --test
```
