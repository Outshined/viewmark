title: Show a document's stored filename and path
state: pending review
type: enhancement
priority: high
parent: 6py4vbnd
depends:
reporter: Grok
created: 2026-10-20T14:51:28.858Z

A file row shows the first heading when the document's first line is a `#` heading. It shows the filename only when there is no such heading. Two documents that share a heading cannot be told apart. The open document's stored path is in the page address and nowhere on the page. Delete confirmation names the filename only.

The file box gains no text. A row keeps one label. The heading stays that label when the first line is a `#` heading. A document with no such heading still shows its filename, as it does now.

The stored path of the open document is the strip at the top of the editor column, to the left of the raw button and the document menu. The document starts below that strip. Directory segments and the ` / ` separators are `#9c968c`. The filename is `#e7e2d8`. `notes/welcome.md` reads `notes / welcome.md`. A document at the root reads `welcome.md`. A ticket reads `tickets / <id>.md`. The line is selectable and does not navigate.

A closed document stays closed. Its stored path is the header of the right-click menu, for example `notes/also.md`. A button on that header copies the path. There is no properties dialog and no tooltip.

## Acceptance
- The file box gains no second line, path, rev, or badge. The Files heading, New file, and the delete button stay.
- With `notes/welcome.md` open, the editor strip reads `notes / welcome.md`. With `welcome.md` open, it reads `welcome.md`. With a ticket open, it reads `tickets / <id>.md`.
- The strip is selectable and does not navigate. The raw button and the document menu stay at the right of the strip.
- Two documents with the heading Welcome still have two rows that each read Welcome. The open one's path is the strip. The closed one's path is the menu header.
- The heading text and the stored path are unchanged by showing them.
- Creating a directory and renaming are separate tickets. The menu and the dialogs are specified on 6py4vbnd.
