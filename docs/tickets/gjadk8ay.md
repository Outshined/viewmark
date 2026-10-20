title: Create and remove a directory from the file pane
state: closed
type: enhancement
priority: high
parent: 6py4vbnd
depends:
reporter: Grok
created: 2026-10-20T14:51:28.991Z

There is no way to create a directory on its own. New file, and `create` on the CLI, make missing parent directories only while creating a markdown document. A directory with no markdown file under it does not appear. Move refuses a destination that does not already contain a markdown file, so a directory cannot be prepared and then filled.

The file pane can create a directory before it holds a document. That directory appears and can hold a new document or a document moved into it. The same create, and removal of an empty directory, exist on the CLI.

A new directory uses the same segment rules as a document path. Each segment is lowercased. Characters that are not letters or digits become dashes. Repeated dashes collapse, and dashes at either end of a segment are removed. Digits stay. No `.md` suffix is added. An empty segment, `.`, `..`, `.git`, a path over 1024 characters, and anything under `tickets/` is refused and writes nothing. A directory the pane already shows is left as it is. One existing directory whose name normalizes to the new segment is that directory.

A picture directory is the document path without `.md` or `.markdown`. `welcome.md` owns `welcome/`. That directory is not a row in the file pane while it holds no markdown file. Creating a directory that is some document's picture directory is refused and writes nothing.

## Where
New directory is not a control in the file box. It is the New directory item on a directory's menu and on the empty-tree menu. The dialog title is New directory. Under the title, a muted line (`#9c968c`) says `In notes/` when the menu was on the notes directory, and `In the file root` when the menu was on the empty tree. The label is Name. The field starts empty. The buttons are Cancel and Create.

New document uses that same dialog. The title is New document. Create stores the document with the existing create rules, including a later stem when the name is taken, and the dialog closes on the stored path.

A refused directory name leaves the dialog open and shows one line under the field in `#ff7b72`. `That directory holds pictures for welcome.md.` when the path is a document's picture directory. `That name is not allowed.` when the segment is empty, `.`, `..`, `.git`, longer than 1024 characters, or under `tickets/`. A directory the pane already shows is left as it is and the dialog closes.

The pane-head delete button still deletes the open document. Delete on a row's menu uses the confirm dialog. A document asks `Delete welcome.md?`. An empty directory asks `Delete notes?`. A directory that holds documents asks `Delete notes and 4 documents?`. The buttons stay Cancel and Delete. Confirming removes those documents and the picture directory of each. A document another socket holds refuses the remove, names that user, and removes nothing.

A file row's menu is Open, then Delete. Open opens that document and closes the menu. The header and the copy button stay as they are. Rename is a separate ticket.

The CLI commands are `directory create <path>` and `directory delete <path>`. Create prints the stored path. Delete removes a directory only when it holds no documents.

## Acceptance
- New directory opens the New directory dialog from a directory menu or the empty-tree menu. The file box gains no control and no field.
- `In notes/` or `In the file root` names the parent. Create with Name `Drafts` inside notes stores `notes/drafts` and shows that directory while it holds no document.
- New document opens the same dialog with the title New document and stores the document under that parent.
- A picture-directory name stays in the dialog with `That directory holds pictures for welcome.md.` A rejected segment stays in the dialog with `That name is not allowed.`
- Menu Delete asks `Delete notes?` or `Delete notes and 4 documents?`. The pane-head delete button still deletes the open document.
- Open on a file row's menu opens that document and closes the menu.
- `directory create` prints the stored path. `directory delete` removes only an empty directory.
- The stored filename and rename are separate tickets.
