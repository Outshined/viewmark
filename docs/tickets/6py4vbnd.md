title: File handling on the page
state: closed
type: enhancement
priority: medium
parent:
depends:
reporter: Grok
created: 2026-10-20T14:51:28.719Z

The file pane is where a person finds a document and puts it with the others. It lists markdown documents and the directories that hold them. It is not a file manager. The facts worth showing are the stored path and the first heading. Owner, permissions, a mime type, a document rev, and a listing of arbitrary files are out of this set.

New file creates a document. A path with segments creates missing parent directories while creating that document. Nothing on the page or in the CLI creates a directory by itself. A directory appears only when a markdown file is stored under it. Dragging moves a document or a directory and keeps the last segment of the path. Move refuses a destination that does not already contain a markdown file. Delete removes the open document. A row shows the first heading when the first line is a `#` heading, and the filename otherwise. The stored path is written into the page address and is not shown in the pane or on the document.

## Decisions
- The heading stays the name a person reads. {c1}The open path is a line at the top of the editor. A right-click menu shows a closed document's path. The file box gains no text.{/c1}
- A directory can exist before it holds a document. A document can be created in it or moved into it.
- Rename changes the stored last segment. The heading stays. Picture paths inside a moved document are updated the way move already updates them.
- There is no properties dialog and no tooltip. The menu header is the stored path. A copy button on that header copies the path. Decided on 2026-10-20.
- A picture directory stays out of the file tree. `tickets/` stays the ticket store.
- Delete of the open document stays as it is.

## Placement
The file box is unchanged. The Files heading, the New file button, the delete button, and each row stay as they are. A row still shows one label: the first heading, or the filename when the first line is not a `#` heading. A directory row still shows its segment. No second line, path, rev, or badge is added in the file box. The New file field stays in the file box and still accepts a typed path.

The open document's stored path is one line in a strip at the top of the editor column. The strip is 0.35rem plus 1.75rem plus 0.35rem tall, background `#1c1b19`, with a bottom border `#4a463f`. The document starts below the strip. The raw button and the document menu sit at the right of the strip. The path sits at the left and does not run under the buttons. Directory segments and the ` / ` separators are `#9c968c`. The filename is `#e7e2d8`. The line is selectable and is not a link. `notes/welcome.md` reads `notes / welcome.md`. A document at the root reads `welcome.md`. A ticket reads `tickets / <id>.md`.

A right-click opens a menu, class `md-file-menu`, using the document menu panel: background `#242320`, border `#c4b8a4`. The menu's top-left corner is the pointer. A left-click still opens a document or expands a directory. The first line of the menu is the stored path, color `#9c968c`, and it is not a command.

On the right of that path is an icon button, 1.75rem square, accessible name Copy path. The glyph is a 24 by 24 stroke icon: viewBox `0 0 24 24`, no fill, stroke `currentColor`, stroke width 2, round caps and round joins, and `aria-hidden` on the SVG. The mark is two rectangles, the back one at x 4 y 4 sized 12 by 12 and the front one at x 8 y 8 sized 12 by 12. A click copies the stored path, for example `notes/also.md` or `notes`, with slashes and without the spaces the strip shows, and leaves the menu open. There is no tooltip. The header `File root` has no stored path and no copy button.

A file row's menu is Open, Rename, Delete. Delete is `#ff7b72`.
A directory row's menu is New document, New directory, Rename, Delete.
The empty part of the file tree uses the header `File root` and the items New document, New directory.

The document menu order is Attach image, Rename, Delete file, Vim keys. Rename is hidden on a ticket, as Delete file already is.

Rename, New document, and New directory are dialogs centered on the page. They use the confirm dialog's colors, background `#242320` and border `#3f3c37`. Each is 18rem wide. Cancel is the first button and the action is the second. Escape cancels. Enter submits a dialog that has a Name field.

Path bar and file menu. The marked picture still lists Properties. That item is not in the menu.

![qukhzdwc.png](tickets/6py4vbnd/qukhzdwc.png)
```comment c2 0.3845,0.3367
:: 0
@2026-10-20T16:35:06.127Z Operator
I like this.  Please include a copy glyph button here that copies the path.
:: 1
@2026-10-20T16:54:56.541Z Grok
The copy button is on the right of the menu header in the new picture. It copies the stored path, such as notes/also.md or notes, and the menu stays open. The header File root has no path and no copy button. Properties is not a menu item.

```

Menu header with the copy button. Properties is not an item.

![va5sf9ck.png](tickets/6py4vbnd/va5sf9ck.png)

Directory menu, new directory, and rename. The directory header has the same copy button.

![ygcb9hw6.png](tickets/6py4vbnd/ygcb9hw6.png)

## Acceptance
- Show the stored filename and path (2dtwbgm2), create and remove a directory (gjadk8ay), and rename a document or a directory (eftpk82u).
- The file box gains no text. The open path is the editor strip. A closed path is the right-click menu header. The copy button on that header copies the stored path. There is no properties dialog and no tooltip.
- This ticket is done when those three are done.
- cyd6xwc8 is the refused properties dialog. It adds nothing to this set.
- This set does not add owner, permissions, a mime type, or a browser for files that are not documents or a document's pictures.

```comment c1
:: 0
@2026-10-20T16:12:11.291Z Operator
This gets too crowded.  Does this go into a tooltip, a separate thing the user selects, where?  
:: 1
@2026-10-20T16:25:02.151Z Grok
The file box stays one label per row. It is not a tooltip. The open document's path is the strip at the top of the editor, left of the raw button and the document menu. A right-click opens a menu whose header is the stored path. Properties, rename, and new directory are dialogs. The three mockups are under Placement on this ticket.

:: 2
@2026-10-20T16:54:56.607Z Grok
There is no tooltip and no properties dialog. The right-click menu header is the stored path, and the button on that header copies it. Rename, new directory, and new document stay dialogs.

```
