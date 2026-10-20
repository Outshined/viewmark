title: Rename a document or a directory
state: pending review
type: enhancement
priority: medium
parent: 6py4vbnd
depends:
reporter: Grok
created: 2026-10-20T14:51:29.125Z

Move keeps the last segment of the path. Nothing on the page or in the CLI changes that segment. Changing the heading does not change the stored name.

Rename keeps the parent and changes the last segment of a document or a directory. The heading and the prose stay. Picture paths inside the document are updated the way a move already updates them. An open document follows the new path the way it follows a move. A directory rename moves every document under it.

The new segment uses the same spelling rules as document create. A name that contains a slash is refused. A name that normalizes to a document or directory that is already there is refused and reported. Nothing is written. The create behavior that stores a later stem when the name is taken does not apply. Tickets are not renamed.

## Where
Rename is the Rename item on a file menu, a directory menu, and the document menu. The document menu renames the open document. The dialog title is Rename. The muted line says `In notes/` or `In the file root`. The label is Name. The field holds the current last segment, including `.md` or `.markdown` for a document. The buttons are Cancel and Rename.

A refused name leaves the dialog open, writes nothing, and shows one line under the field in `#ff7b72`. `That name is already used.` when the normalized name is taken. `That name is not allowed.` for a slash, an empty segment, or the same rejects as a new directory. `A picture directory is in the way.` when the picture directory cannot move with the rename.

The CLI command is `rename <path> <name>`. `<name>` is one segment.

## Acceptance
- Rename on a file menu, a directory menu, and the document menu opens the Rename dialog. The file box gains no field.
- The Name field starts as `welcome.md` for that document, or as the directory segment for a directory. The muted line is `In notes/` or `In the file root`.
- A taken name shows `That name is already used.` and the path is unchanged. A slash shows `That name is not allowed.`
- After a document rename the heading is the same. The editor strip shows the new filename. An open document follows the new path.
- A directory rename updates the path of each document under it. Picture paths inside those documents are updated the way move updates them.
- `rename <path> <name>` does the same write. `tickets/` cannot be renamed, and a ticket cannot be renamed this way.
- The stored filename display and directories are separate tickets.
