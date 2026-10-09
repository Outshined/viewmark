This was a quick weekend vibe-coding run with Grok.  I tend to run multiple agents, or agents on long runs while I'm not there.  Rather than having to scroll back and figure out what happened, I have them report status and open questions in docs.  Often this is just markdown, but why not have some fun with it?
I really like the way Obsidian edits markdown, and nothing else seems to do that.  So I had Grok (after I beat the idea of having to pixel-fsck to find characters on the screen) to build a view that renders markdown and lets you edit it, then split it into a  backend API.
Having a task list, basically tickets, helps keep track of TODOs and stuff, useful on projects that last longer than a day.

I suppose a custom ticket thing for coding AIs is the 2020's version of a Pet Rock, as the 90's version was a personal home page, right?  In my defense, I've put less time into this than I did a home page in the 90s.  ;-P

Put here in case anyone else finds it useful.

Disclaimer: This is 100% Grok coded,  I've sent it off to find various bugs and asked it to do things, but I've never opened a single source file or looked at any of it.  It seems to do what I asked, so am happy.

# Viewmark

Viewmark is specifically designed for interacting with agents across multiple projects. One hub holds the open documents. Each project is its own directory of markdown, registered by name. An agent uses the CLI to list, show, edit, comment, and file tickets. The browser shows those same documents to a person. Both see the same bytes.

The markdown is the dialect used by GitHub, GitLab, and Obsidian. A fenced block tagged `mermaid` is drawn as a diagram. HTML in the document is stored as text and is not rendered.

In the age of vibe coding, Viewmark is like a Pet Rock. This is my Pet Rock, and I'm quite pleased with it.

AGENTS.md is the contract for a program that edits documents through the CLI, or that changes this source.

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
printf '%s\n' '@@' '-Hello' '+Hi' | viewmark --user ada --repo notes edit welcome.md
```

`show` prints the document on stdout and `rev N` on stderr. `create` reads the body from stdin when stdin is not a terminal. Pass `--file` to read a file instead. A path without a markdown suffix is stored with `.md` added. `edit` reads a unified diff on stdin. `--start` and `--end` together limit the slice. The old lines must occur once inside that slice. A context mismatch changes nothing.

You send the text of one comment note. The hub writes the note id and the author line.

```
viewmark --user ada --repo notes comment list welcome.md
printf 'A correction.\n' | viewmark --user ada --repo notes comment reply welcome.md THREAD
```

`comment edit` addresses one note by id and requires `--expect`, the note text after the poster line. `comment add` requires `--expect` equal to the bytes at the range. A reply does not take `--rev`. `comment resolve`, `comment open`, and `comment delete` act on one thread. `--rev` on those is rejected. A reply on a ticket stores the note, the author, and the time. `ticket set` writes a field of the current body. Later field writes win. `--rev` on those writes is rejected.

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
