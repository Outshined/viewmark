title: Search docs and tickets
state: closed
type: enhancement
priority: medium
parent:
depends:
reporter: Grok
created: 2026-10-22T03:52:40.509Z

## Search
The Files pane and the Tickets pane each gain one search glyph. {c5}The query is a regular expression. A pattern with no metacharacters matches that plain string. There is no separate control. A pattern the engine rejects does not search, and the field shows that the pattern is invalid.{/c5} {c4}A match is case-sensitive.{/c4} {c3}The existing ticket filter stays. A ticket the filter hides stays hidden.{/c3}

## Controls
The Files head is the heading, New file, Delete file, then Search files. The Tickets head is the heading, New ticket, Filter, then Search tickets. Each glyph is a 24 by 24 stroke icon: viewBox 0 0 24 24, no fill, stroke currentColor, stroke width 2, round caps and round joins, and aria-hidden on the SVG. The two paths are in the fence. The accessible names are Search files and Search tickets.
```text
M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16
M21 21l-4.3-4.3
```
Clicking the glyph shows a text field as the first block under that pane's head. Escape clears the field and hides it. A query with no characters shows the whole list and does not ask the hub. A query of spaces searches for those spaces.
A pattern the engine rejects does not search. The field shows that the pattern is invalid, and the list stays as it was.

## What is searched
The match function lives in src/doc.js. It returns the non-overlapping match ranges, walked left to right. The hub and the page both call it. The query cat matches catalog. The query aa in aaa is one range, at the start. The query a+ matches the whole run of a's.
A document matches when its stored text, its stored path, or its pane label contains a match. A ticket matches when its body or its title contains a match. {c2}The title is part of the searched text. The other header lines are not.{/c2} {c1}The path and the pane label are part of the searched text. The row highlights the matching path, label, or title so the match is obvious.{/c1} Comment fences in the stored text are part of it.
The search covers the open repo only. A docs search does not return tickets. A tickets search does not return documents.

## List
The page does not hold every file's text. It sends the query to the hub. The hub answers with the matching paths. An answer for a query that is no longer in the field is ignored.
The Files list keeps a document whose path was returned, and keeps a directory that contains such a document. Every other document and directory is hidden. The row highlights the matching path or pane label.
The Tickets list keeps a ticket whose file was returned and that the filter still shows. A title match is highlighted on the row. Sort still applies to the rows that remain.
When a docs or tickets payload arrives and the field has a query, the page asks again. Until that answer, the list can still show a file an edit has just taken the match out of. The open file's hits follow its current text at once.
Vim slash search is a different command and is unchanged. An open file that is not a match stays open, with no hits.

## Highlight
Opening a matching file highlights every body range. The page runs the same match function on the open string. A file kept only because its path or pane label matched shows no body hits. For a ticket, the ranges are body offsets, shifted by the body's start in the file.
The hit is a span with class md-search-hit, background #3f5344 and text #e7e2d8. That is neither the selection #3d5a80 nor a comment #6b5e45. A selection can sit on a hit. Both stay.
The first hit is brought into view the way a caret jump is. Hits paint on drawn text, on the caret line, and in the raw view. A match inside a picture destination or a mermaid source is still a match for the list, and it paints when that source is drawn.
Clearing the query removes the hits.

## Hub and CLI
The page message has type search, kind docs or tickets, and the query. The answer repeats the kind and the query and lists the paths.
The command takes one of --docs or --tickets, and the query is one argument. It prints one path per line. --user and --repo are required, as on every document command.
An invalid pattern exits with an error and writes nothing.
```text
viewmark --user NAME --repo NAME search --docs QUERY
viewmark --user NAME --repo NAME search --tickets QUERY
```

## Acceptance
A Firefox test covers the two glyphs, the field, Escape, and an empty query.
A document whose text, path, or pane label matches stays in the Files list, and the row highlights the matching path or label. A document that matches none of those is hidden. A directory with no matching document is hidden.
A ticket whose body or title matches stays in the Tickets list when the filter allows it, and a title match is highlighted on the row. A ticket the filter hides stays hidden.
Opening the file paints every body match, including a second match on a later line, and the first match is in view. A file kept only because its path or pane label matched shows no body hits.
An invalid pattern leaves the list as it was and the field shows that the pattern is invalid. Alpha does not match alpha.
A unit test covers the match function: two hits, a longer match that swallows a shorter one, the single range of aa in aaa, a+ over a run of a's, and a ticket body offset that skips the header.

## Waiting
The five threads have answered. The sentences above are the decisions.

```comment c1
:: 0
@2026-10-22T03:53:27.627Z Grok
Should a document match when the query is in the stored path or the pane label and not in the text?

:: 1
@2026-10-22T16:23:02.680Z Operator
As long as it's obvious to the user what is matching,  yes.
```

```comment c2
:: 0
@2026-10-22T03:53:27.710Z Grok
Should a ticket match when the query is in the title and not in the body?

:: 1
@2026-10-22T16:22:35.653Z Operator
Yes.
```

```comment c3
:: 0
@2026-10-22T03:53:27.791Z Grok
Should a search show a ticket the filter is hiding, such as a closed ticket, when the body matches?

:: 1
@2026-10-22T16:22:12.527Z Operator
No, honor the filters.
```

```comment c4
:: 0
@2026-10-22T03:53:27.872Z Grok
Should a match ignore case? Alpha does not match alpha under this sentence.

:: 1
@2026-10-22T16:21:54.330Z Operator
Case sensitivity is more geek-friendly, especially when we have regex to work with.
```

```comment c5
:: 0
@2026-10-22T03:53:27.955Z Grok
Is the query only this plain string, or does the field also take a regular expression? A regular expression needs a way to turn it on, and a rule for a pattern the hub rejects.

:: 1
@2026-10-22T16:21:20.426Z Operator
Accept regex syntax, which should match on a plain string as well.
```
