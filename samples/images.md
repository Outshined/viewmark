# Images

A picture stays out of the document string. The document holds an image line. The bytes live in a directory named for that document. The hub writes both. The page and a script read the bytes back from this same hub.

The image line is markdown, and the page draws it:

```
![k3m9qp2x.png](tickets/48w97e8c/k3m9qp2x.png)
```

The line stands alone, so it is one lock span. The alt text is the file name. The address is relative to the repository root, and the page requests `/raw/<repo>/tickets/48w97e8c/k3m9qp2x.png`. An address that starts with `https://` or `http://` is used as it is. A `data:` address is not written. A fence is a block of source, and a screenshot is not one.

The directory sits beside the markdown. `tickets/<id>.md` owns `tickets/<id>/`. `notes/welcome.md` owns `notes/welcome/`. The directory is not a document, and it does not appear in the file list.

## A script

A test that has caught a failure creates the ticket, then attaches the screenshot it holds.

```
id=$(viewmark --user tester --repo app ticket create --title "Login stalls" --type bug <<'BODY'
The character never enters the room.
BODY
)
viewmark --user tester --repo app attach "tickets/$id.md" --start 1:0 --end 1:3 --expect The < room.png
```

One command, `attach <path> --start LINE:OFFSET --end LINE:OFFSET --expect TEXT`, sends the bytes for a ticket and for any other document. The three flags are required. `--expect` is the text at that range, and a mismatch is 409. A range outside the document, or one that spans two blocks, is 400. A ticket's path is `tickets/<id>.md`. The hub makes a name the way it makes a ticket id, and writes `tickets/<id>/<name>.<suffix>`. The image line follows the block that holds the range, as its own paragraph. An empty range on the blank line between two paragraphs puts the line on that blank line. A range in a fence or a table puts the line after the whole fence or table. When another session holds the block at the range, or a span the splice touches, the hub writes neither the line nor the file, returns 409, and names that user. A session in another block does not stop it. Another shot is the same command, and the hub makes another name. `attach` prints what `show` prints.

{c8}The same `attach <path>` is the command for a document that is not a ticket.{/c8} The file lands beside that document, and the image line follows the block that holds the range.

`ticket show` prints the image line with the body. The bytes come from the `/raw` address.

## A person

The document or the ticket is open. The person pastes a picture, drops a file, or picks one with Attach image in the document menu. Pasted text that is a `data:image/…;base64,` address is decoded and sent as bytes. The page sends the bytes. {c9}The hub makes an id the way it makes a ticket id, and that id and the suffix are the file name.{/c9} {c7}The picture follows the block that holds the caret, as its own paragraph, and the caret ends after the image line. A script names a range, and the line follows the block that holds it.{/c7} Clicking the picture selects its image line. Backspace or Delete removes that line.

The hub reads the kind of picture from the bytes, and the suffix is png, jpg, gif, or webp. Other bytes are 400. A name is one path segment. {c6}If that id is already in the directory, the hub makes another. The person does not choose the name.{/c6} The hub also makes another when the document already names that file, and after eight tries it returns 500.

{c5}A comment note stays text.{/c5} A screenshot goes in the document.

## A move

Changing a ticket's title does not move the file. The id is the filename, and the directory is `tickets/<id>/`. A ticket cannot be moved.

Moving `notes/welcome.md` to `archive/` moves the markdown and moves `notes/welcome/` to `archive/welcome/` at the same time. The hub rewrites image addresses in that document from `notes/welcome/` to `archive/welcome/`. Other documents are not rewritten. A destination that already has that directory is 409, and both stay where they were.

Retyping an image line does not move the bytes. The old address becomes unreferenced.

## A picture nobody names

Selecting the picture and pressing Backspace removes the line. A diff that drops the line does the same. The file stays while a session has the document open. A CLI command that edits or attaches counts as a session until it exits. {c4}Undo puts the line back, and the picture is still there.{/c4} When the last session closes the document, the hub deletes each file in the directory that no image line in the document still names.

## A deleted document

Deleting the document, deleting the ticket, or purging a closed ticket removes the markdown and removes its directory. {c3}A move rewrites no other document, and a delete removes the directory even when another document names a file in it.{/c3}

## The upload

An attach is a JSON text frame, `{type:"attach", username, path, …}`, followed by one binary frame that holds the raw bytes. The CLI's frame carries `start`, `end`, and `expect`, and the page's carries `cursor`. A binary frame with no attach before it closes the socket. A hub frame may be 2 MiB, and a larger one closes the socket. The bytes are not base64 inside a JSON text frame, because that encoding of a 2 MiB image would pass the frame limit. Later edits broadcast the image line, not the bytes. Empty bytes, bytes over the limit, and bytes that are not a picture are each 400. The CLI and the page refuse empty or oversize bytes before they send them.

`attach` and a paste {c2}send the bytes on that socket{/c2}. The hub writes the file and splices the image line before it answers. The page and a script read the bytes with `GET /raw/<repo>/<path>`. That route serves any file in the repository, for GET and HEAD. {c1}One image may be at most 2 MiB.{/c1}

```comment c1 resolved
:: 0
@2026-10-09T01:52:50.762Z Grok
What is the largest image the hub should store?

:: 1
@2026-10-09T02:47:16.114Z Operator
Same as above - 2MB should be enough.  If we smack into that, something is probably wrong.
```

```comment c2 resolved
:: 0
@2026-10-09T01:52:50.825Z Grok
The bytes arrive as an HTTP POST because a hub frame stops at 1 MiB. Should that be the upload, or should the frame limit be raised so the bytes travel on the same socket as other commands?

:: 1
@2026-10-09T02:46:53.406Z Operator
Bump the limit to 2mb.  I don't know that we need more than that.
```

```comment c3 resolved
:: 0
@2026-10-09T01:52:50.890Z Grok
The directory belongs to one document. A move rewrites every image address in the repository. Delete removes the directory even if another document still names it. Should another document be allowed to point at the file, and should delete keep the file while any document still names it?

:: 1
@2026-10-09T02:45:50.885Z Operator
No, keep them separate.
```

```comment c4 resolved
:: 0
@2026-10-09T01:52:50.950Z Grok
The file is deleted in the same turn as the last reference, and undo restores the line but not the bytes. Should the file stay until the last person closes the document, so undo can restore the picture?

:: 1
@2026-10-09T02:45:22.608Z Operator
Yes.
```

```comment c5 resolved
:: 0
@2026-10-09T01:52:51.015Z Grok
A comment note stays text, and a screenshot goes in the document. Does a thread need a picture of its own?

:: 1
@2026-10-09T02:43:55.211Z Operator
Comments are just text, keep it simple.
```

```comment c6 resolved
:: 0
@2026-10-09T01:52:51.075Z Grok
A duplicate name is refused. Should it replace the file instead? Should a person be able to choose the name, or is shot-1.png enough?

:: 1
@2026-10-09T02:43:05.606Z Operator
Note above - just generate a random name for it.
```

```comment c7 resolved
:: 0
@2026-10-09T01:52:51.137Z Grok
A script appends the picture at the end. A paste inserts it after the block that holds the caret. Should a paste do that, or should it append too?

:: 1
@2026-10-09T02:53:15.549Z Operator
I don't follow - why would a script only append?  Need to be able to paste in an image anywhere necessary in a doc.
```

```comment c8 resolved
:: 0
@2026-10-09T01:52:51.198Z Grok
Is ticket attach for a ticket, and attach PATH for any other document, the split you want?

:: 1
@2026-10-09T02:41:17.876Z Operator
They can be the same.
```

```comment c9 resolved
:: 0
@2026-10-09T02:42:17.911Z Operator
Or just make up IDs like the tickets for pasted images.
```
