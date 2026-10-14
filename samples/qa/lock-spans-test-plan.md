# QA plan: lock spans and wrapped paragraphs

Contract: Consecutive non-blank prose lines are one lock span and one wrapped block. A source newline inside that block displays as a space and maps back to that newline. A newline after two or more trailing spaces, or after a trailing `\`, is a hard break instead; those marker characters are not displayed. A blank line is its own span. A heading or a thematic break is its own span and ends a paragraph even when no blank line is present. `>` is written once, on the first line of a quoted paragraph or a quoted item (`> - `, `> 1. `, and the same for `+`, `*`, or `N)`); continuation lines do not repeat it. A child item is indented and has no `>`. A fence, a table, or a heading ends the quote. A thematic break also ends the quote, because it is not continuation text. Consecutive quoted blocks with only blank lines between them share one quote bar and stay separate spans. Each list item is one span and one wrapped block, marker shown once, including continuation lines, until a blank line, a fence, a table, a heading, or another item at equal or lesser indent. A child item is its own span. A code fence and a mermaid fence are each one span from the opening line through the closing line. A comment fence is the opener, one span per note, and the closer. A table is the header plus the delimiter as one span, then one span per body row. An image has no span of its own. Wrapping does not change the file bytes. A caret inside a paragraph, a quote, or a list item does not split that block back into source rows. A diff hunk may cross span boundaries, and the hub applies it unless another socket holds a span it touches, which is 409. A hunk that merges or splits comment notes is 409 and writes nothing. Two editors may hold different spans of the same file. They may not hold one span together.

Setup: From the repository root the suite is `node --test`. Do not start the live hub. A case that applies a hunk starts a hub of its own, on a free port with a temporary directory. This file is the contract the cases have to meet. A source in double quotes is a JSON string (`JSON.parse`). A source in backticks decodes only these escapes: `\n` is a newline, `\t` is a tab, and `\\` is one backslash. No other backslash is an escape, and the literals are not JavaScript template strings. Length is the length after that decode. `classify` decides the line: a line that starts with `> ` is a quote; otherwise it is `p`, `h`, `hr`, `li`, or `ol`. `fenceOpen` pairs with the next closing fence, or runs through EOF when none exists. `isTableStart` is a row plus a delimiter row. `parseCommentNotes` splits notes on a `::` line. A blank line is a line whose text is empty. A line of spaces is `p`, not blank. Spans are a total partition of character indexes `0` through `length - 1`. Offsets below are inclusive, so a span `start-end` is `source.slice(start, end + 1)`. The newline that ends a span's last line is inside the span. The extra empty line `lineSpans` reports after a trailing newline is not a span. A non-empty file therefore has no span at index `length`. The empty string is the one vacant span: no character, one block, one lock. A caret at offset `c` locks the span with `start <= c <= end`. A caret at `length` locks the span that owns `length - 1`. A hunk is a unified diff hunk applied with the CLI's `edit`, as `AGENTS.md` describes: its old lines are its context and `-` lines, and they must match once. A newline inside a span is not a boundary. Status 409 leaves the bytes identical and grants no lock. Two held spans may both be written; a write in one is not a stale-rev 409 for the other. A child item's bytes are not in the parent span. The parent stops at the child and does not resume. A later non-item line belongs to the innermost open item. Quote, list, and hard-break markers are not prose. Every other character displays as itself, except a soft newline, which displays as one space. The suite reads spans, the block for each span, the offset a displayed space maps to, the bytes after a wrap, and the lock or edit result.

Out of scope, and not cases below: the ticket header, a quoted fence, a quoted table, comment authorship, and rewriting the file on disk. Do not assert who may edit a note. Do assert that an author line sits inside its note span rather than in a span of its own.

Cleanup: a case that starts a hub stops it and removes its directory. The other cases load nothing and write nothing.

Steps:

1. vacant document
   source: `` (length 0)
   spans: one vacant span, no inclusive indexes
   display: one empty block
   second: a second lock of that span returns 409; there is no other span to change
   expect: one span, bytes stay ``
   fail if: a blank-line span, a second span, or a newline is invented

2. one newline
   source: `\n` (length 1)
   spans: blank `0-0` `\n`
   display: one empty block
   second: a second lock returns 409
   expect: exactly one span, the character at 0
   fail if: the phantom line at index 1 is a span, or the newline is dropped

3. two newlines
   source: `\n\n` (length 2)
   spans: blank `0-0` `\n`; blank `1-1` `\n`
   display: two empty blocks
   second: may hold offset 1 while offset 0 is held, and may replace neither character of the other span
   expect: two spans
   fail if: one span covers both newlines, or a third span exists at index 2

4. soft paragraph
   source: `Alpha\nBeta\n` (length 11)
   spans: `0-10` `Alpha\nBeta\n`
   display: one block `Alpha` ␣@5 `Beta`. The space maps to the newline at 5, whose character is `\n`. The newline at 10 is not displayed
   second: no other span. A second lock returns 409
   expect: one span, one block, bytes unchanged
   fail if: two line blocks, a span boundary at 5, the mapped offset is a space character, or the planner inserts a space

5. caret on the second source line
   source: `Alpha\nBeta\n` (length 11)
   spans: `0-10`
   display: caret at 0, at 5, and at 6 each still show one block `Alpha` ␣@5 `Beta`, not the source rows `Alpha` and `Beta`
   second: caret at 6 while caret at 0 is held returns 409; the first hold remains; bytes stay `Alpha\nBeta\n`
   expect: one block for every caret inside the span
   fail if: the caret restores source rows, or the second caret is granted the second line

6. no trailing newline
   source: `Alpha\nBeta` (length 10)
   spans: `0-9` `Alpha\nBeta`
   display: `Alpha` ␣@5 `Beta`
   second: caret at 9 and caret at 0 are the same span; the second lock returns 409
   expect: one span ending on `a` of `Beta`
   fail if: a phantom span is appended, or the end offset is 10

7. caret at end of file
   source: `Alpha\nBeta\n` (length 11)
   spans: `0-10`
   display: caret at 11 still shows the one wrapped block
   second: caret at 11 while caret at 0 is held returns 409
   expect: the caret at `length` locks `0-10`
   fail if: index 11 is its own span, or the second caret is granted a lock

8. blank lines split paragraphs
   source: `Alpha\n\n\nBeta\n` (length 13)
   spans: `0-5` `Alpha\n`; blank `6-6` `\n`; blank `7-7` `\n`; `8-12` `Beta\n`
   display: `Alpha`; empty; empty; `Beta`. No joining space across a blank
   second: may replace `Beta` with `Gamma` while `Alpha` is held, producing `Alpha\n\n\nGamma\n`. May hold offset 6 while both paragraphs are held
   expect: four spans
   fail if: `Alpha` and `Beta` are one span, or either blank is missing

9. a space-only line is not blank
   source: `Alpha\n \nBeta\n` (length 13)
   spans: `0-12` `Alpha\n \nBeta\n`
   display: one block `Alpha` ␣@5 ` ` ␣@7 `Beta` (three spaces). The middle space is source offset 6
   second: no other span. A lock of only the middle line returns 409 and does not split the span
   expect: one paragraph span
   fail if: a blank span at 7, or three spans

10. heading ends a paragraph
    source: `words\n# Title\nmore\n` (length 19)
    spans: `0-5` `words\n`; heading `6-13` `# Title\n`; `14-18` `more\n`
    display: prose `words`; level-1 heading `Title` (the `# ` is not prose); prose `more`
    second: may replace `more` with `less` while `words` is held, producing `words\n# Title\nless\n`. Must not lock `0-5` as well
    expect: three spans. A hunk that changes `words` and `# Title` together, to `words!` and `# Title!`, is applied: `words!\n# Title!\nmore\n`
    fail if: one span, or the heading text includes `#`

11. level-6 heading
    source: `###### Title\n` (length 13)
    spans: heading `0-12` `###### Title\n`
    display: level 6, prose `Title`
    second: no other span
    expect: one heading span
    fail if: the hashes are prose, or the level is not 6

12. seven hashes are prose
    source: `####### no\n` (length 11)
    spans: `0-10` `####### no\n`
    display: prose `####### no`, not a heading
    second: no other span
    expect: one `p` span
    fail if: a heading span, or the hashes are stripped

13. heading requires the space
    source: `words\n#Title\nmore\n` (length 18)
    spans: `0-17` `words\n#Title\nmore\n`
    display: `words` ␣@5 `#Title` ␣@12 `more`
    second: no other span. A lock of only `#Title` returns 409
    expect: one paragraph
    fail if: a heading span splits the lines

14. thematic break ends a paragraph
    source: `words\n---\nmore\n` (length 15)
    spans: `0-5` `words\n`; hr `6-9` `---\n`; `10-14` `more\n`
    display: `words`; one rule, not the characters `---`; `more`
    second: may hold `10-14` while `0-5` is held
    expect: three spans. A hunk that changes `words` to `words!`, with `---` as an old line, is applied: `words!\n---\nmore\n`
    fail if: the dashes are joined into the paragraph, or the rule prints `---`

15. the three rules
    source: `***\n___\n---\n` (length 12)
    spans: hr `0-3` `***\n`; hr `4-7` `___\n`; hr `8-11` `---\n`
    display: three rules, not one paragraph and not a list
    second: may hold `4-7` while `0-3` is held
    expect: three hr spans
    fail if: `***` is a list item or one wrapped paragraph

16. four dashes are prose
    source: `words\n----\nmore\n` (length 16)
    spans: `0-15` `words\n----\nmore\n`
    display: `words` ␣@5 `----` ␣@10 `more`
    second: no other span
    expect: one paragraph
    fail if: an hr span, or the dashes are not shown

17. a padded rule is prose
    source: `words\n ---\nmore\n` (length 16)
    spans: `0-15` `words\n ---\nmore\n`
    display: `words` ␣@5 ` ---` ␣@10 `more`
    second: no other span
    expect: one paragraph
    fail if: an hr span

18. setext is prose
    source: `words\n===\n` (length 10)
    spans: `0-9` `words\n===\n`
    display: `words` ␣@5 `===`
    second: no other span
    expect: one paragraph
    fail if: a heading span or an hr span

19. zero trailing spaces, soft
    source: `red\nblue\n` (length 9)
    spans: `0-8` `red\nblue\n`
    display: `red` ␣@3 `blue`
    second: caret on `blue` (offset 4) while offset 0 is held returns 409
    expect: one span; bytes stay `red\nblue\n`
    fail if: a hard break, or the bytes become `red  \nblue\n` or `red\\\nblue\n`

20. one trailing space, still soft
    source: `red \nblue\n` (length 10)
    spans: `0-9` `red \nblue\n`
    display: `red ` ␣@4 `blue` (the source space at 3 stays, then the mapped space). Not a hard break
    second: no other span
    expect: one span; bytes stay `red \nblue\n`
    fail if: a hard break, or the space at 3 is deleted from the bytes, or the display equals step 19's `red blue` by rewriting the source

21. two trailing spaces, hard break
    source: `red  \nblue\n` (length 11)
    spans: `0-10` `red  \nblue\n`
    display: `red` ⏎@5 `blue`. Spaces at 3 and 4 are not displayed. Not a joining space
    second: caret on `blue` is the same span and returns 409. A hunk that changes `red  ` and `blue` to `RED  ` and `BLUE` is inside the span and is applied: `RED  \nBLUE\n`
    expect: one span; bytes keep both spaces
    fail if: the display is `red blue`, the spaces are stripped from the bytes, or the interior newline is rejected as a boundary

22. three trailing spaces, hard break
    source: `red   \nblue\n` (length 12)
    spans: `0-11` `red   \nblue\n`
    display: `red` ⏎@6 `blue`. The three spaces are not displayed
    second: no other span
    expect: one span; bytes keep three spaces
    fail if: a soft join, or the bytes are rewritten down to two spaces

23. trailing backslash, hard break
    source: "red\\\nblue\n" (length 10)
    spans: `0-9` `red\\\nblue\n`
    display: `red` ⏎@4 `blue`. The backslash at 3 is not displayed
    second: no other span. A hunk that changes both lines to "RED\\" and "BLUE" is inside the span and is applied: "RED\\\nBLUE\n"
    expect: one span; bytes keep the backslash
    fail if: the backslash is shown, the display is `red blue`, or the bytes are rewritten to `red  \nblue\n`

24. break grades
    source: the five strings in steps 19–23, unchanged
    spans: each is one span, as in those steps
    display: steps 19 and 20 are soft joins and are not the same string. Steps 21, 22, and 23 are hard breaks: `red` then `blue`, with no joining space. Step 21's display matches step 23's display. None of the five source strings match each other
    second: no cross-span edit
    expect: planning leaves each source byte-for-byte
    fail if: a soft display equals a hard display, or any source is rewritten into another grade

25. a backslash that is not the last character
    source: "red\\ \nblue\n" (length 11)
    spans: `0-10` `red\ \nblue\n`
    display: `red\` then the source space at 4, then ␣@5, then `blue`. The backslash is visible. Not a hard break
    second: no other span
    expect: one soft paragraph
    fail if: a hard break hides the backslash

26. backslash at EOF
    source: "red\\" (length 4)
    spans: `0-3` `red\\`
    display: `red\` with the backslash visible. No break
    second: no other span
    expect: one span
    fail if: a hard break, or the backslash is removed

27. two spaces at EOF
    source: `red  ` (length 5)
    spans: `0-4` `red  `
    display: `red  ` including both spaces. No break
    second: no other span
    expect: one span; bytes keep both spaces
    fail if: a hard break, or the spaces are stripped

28. hard break with nothing after it
    source: `a  \n` (length 4)
    spans: `0-3` `a  \n`
    display: `a` ⏎@3 and no second prose line
    second: no other span
    expect: one span, not a paragraph plus a blank
    fail if: the display is `a` plus a joining space, or a blank span is added

29. hard break then a soft newline
    source: `red  \nblue\ngreen\n` (length 17)
    spans: `0-16` `red  \nblue\ngreen\n`
    display: `red` ⏎@5 `blue` ␣@10 `green`
    second: caret on `green` is the same span and returns 409
    expect: one span, one block, two different joins
    fail if: all three words are space-joined, or all joins are hard breaks, or three spans

30. a line of two spaces is a hard break, not a blank
    source: `a  \n  \nb\n` (length 9)
    spans: `0-8` `a  \n  \nb\n`
    display: `a` ⏎@3, then an empty visual line ⏎@6, then `b`. One block
    second: no other span
    expect: one paragraph span
    fail if: the middle line is a blank span, or three spans

31. quoted continuation
    source: `> Alpha\nBeta\n` (length 13)
    spans: quote `0-12` `> Alpha\nBeta\n`
    display: one quote bar, prose `Alpha` ␣@7 `Beta`. No `>` in the prose. One bar, not a bar per source line
    second: caret at `Beta` (offset 8) while offset 0 is held returns 409
    expect: one span and one block, including with the caret on `Beta`
    fail if: two spans, a second `>` is drawn, or the caret restores source rows

32. a bare `>` continues the quote as prose
    source: `> Alpha\n>\n` (length 10)
    spans: quote `0-9` `> Alpha\n>\n`
    display: one bar, prose `Alpha` ␣@7 `>`
    second: no other span
    expect: the second `>` is text inside the one span
    fail if: the second line opens a new quote span, or is dropped

33. `>` without a space is not a quote
    source: `>\n` (length 2)
    spans: `0-1` `>\n`
    display: prose `>`, no quote bar
    second: no other span
    expect: one `p` span
    fail if: a quote bar

34. `>>` is not a quote
    source: `>> Alpha\n` (length 9)
    spans: `0-8` `>> Alpha\n`
    display: prose `>> Alpha`, no bar
    second: no other span
    expect: one `p` span
    fail if: a quote span

35. empty quote line
    source: `> \n` (length 3)
    spans: quote `0-2` `> \n`
    display: one bar, empty prose
    second: no other span
    expect: one quote span
    fail if: a blank span, or no bar

36. quoted blocks share a bar
    source: `> Alpha\n\n> Beta\n` (length 16)
    spans: quote `0-7` `> Alpha\n`; blank `8-8` `\n`; quote `9-15` `> Beta\n`
    display: one quote bar beside all three blocks. Prose `Alpha`, then an empty block, then prose `Beta`. Two quote spans, not one
    second: may replace `Beta` with `Gamma` while `Alpha` is held, producing `> Alpha\n\n> Gamma\n`. May hold the blank at 8 while `Alpha` is held
    expect: three spans, one bar
    fail if: one span for both quotes, two bars, or the second quote is locked by the first hold

37. two blanks between quotes
    source: `> a\n\n\n> b\n` (length 10)
    spans: quote `0-3` `> a\n`; blank `4-4`; blank `5-5`; quote `6-9` `> b\n`
    display: one bar beside the four blocks
    second: may hold offset 4, or the `b` span, while `a` is held
    expect: four spans, one bar
    fail if: the blanks merge, or the bar is dropped between the quotes

38. a heading ends the quote
    source: `> Alpha\n# Title\n` (length 16)
    spans: quote `0-7` `> Alpha\n`; heading `8-15` `# Title\n`
    display: bar plus `Alpha`; then a level-1 heading `Title` with no bar
    second: may hold the heading while the quote is held
    expect: the bar stops before the heading. A hunk that changes `> Alpha` and `# Title` together, to `> Alpha!` and `# Title!`, is applied: `> Alpha!\n# Title!\n`
    fail if: the heading is inside the quote span, or the bar covers `Title`

39. a rule ends the quote
    source: `> a\n---\n` (length 8)
    spans: quote `0-3` `> a\n`; hr `4-7` `---\n`
    display: bar plus `a`; then a rule with no bar
    second: may hold the rule while the quote is held
    expect: two spans
    fail if: `---` is prose inside the quote

40. a plain paragraph after a blank leaves the quote
    source: `> a\n\nplain\n` (length 11)
    spans: quote `0-3` `> a\n`; blank `4-4`; `5-10` `plain\n`
    display: bar plus `a`; empty block with no bar; prose `plain` with no bar
    second: may replace `plain` with `other` while the quote is held
    expect: the bar does not cover `plain`
    fail if: `plain` is a continuation of the quote, or one span

41. a top-level item after a blank leaves the quote
    source: `> a\n\n- b\n` (length 9)
    spans: quote `0-3` `> a\n`; blank `4-4`; item `5-8` `- b\n`
    display: bar plus `a`; empty; marker `-` once and prose `b`, no bar
    second: may hold the item while the quote is held
    expect: the item is not quoted
    fail if: the item is drawn under the quote bar, or the marker is repeated

42. a fence ends the quote
    source: `> Alpha\n```js\nx\n```\n` (length 20)
    spans: quote `0-7` `> Alpha\n`; fence `8-19` is "```js\nx\n```\n"
    display: bar plus `Alpha`; one code block whose body is `x`. The body's newline stays `\n`
    second: may hold the fence while the quote is held
    expect: two spans. The bar does not cover the fence
    fail if: the fence is quoted, or `x` is joined to `Alpha` with a space

43. quoted bullet
    source: `> - Alpha\nBeta\n` (length 15)
    spans: quoted item `0-14` `> - Alpha\nBeta\n`
    display: one bar, marker `-` once, prose `Alpha` ␣@9 `Beta`. No second marker. No `>` in the prose
    second: caret on `Beta` returns 409 while the item is held
    expect: one span, one block, caret on `Beta` included
    fail if: `Beta` is its own span, or a second `-` or `>` is drawn

44. quoted ordered item
    source: `> 1. Alpha\nBeta\n` (length 16)
    spans: quoted item `0-15` `> 1. Alpha\nBeta\n`
    display: one bar, marker `1.` once, prose `Alpha` ␣@10 `Beta`
    second: caret on `Beta` returns 409
    expect: one span
    fail if: the marker is dropped, repeated, or `Beta` is a new item

45. `> -Alpha` is not an item
    source: `> -Alpha\n` (length 9)
    spans: quote `0-8` `> -Alpha\n`
    display: one bar, prose `-Alpha`. The dash is visible. No list marker
    second: no other span
    expect: one quoted paragraph
    fail if: a list span, or the dash is hidden as a marker

46. an indented marker after `>` is not a child item
    source: `>   - child\n` (length 12)
    spans: quote `0-11` `>   - child\n`
    display: one bar, prose `  - child`. No list marker
    second: no other span
    expect: one quoted paragraph. `classify` of the line is quote, and this is not the `> - ` item form
    fail if: a child list span, or the display prose is only `child`

47. quoted item, child, and a following line
    source: `> - Alpha\n  - Beta\nGamma\n` (length 25)
    spans: quoted item `0-9` `> - Alpha\n`; child `10-24` `  - Beta\nGamma\n`
    display: bar, marker `-`, prose `Alpha`. Then, still under that one bar, an indented marker `-` and prose `Beta` ␣@18 `Gamma`. Neither block shows `>`
    second: may replace `Gamma` with `Delta` while `Alpha` is held. The child span becomes `  - Beta\nDelta\n`. Must not lock `0-9`
    expect: `Gamma` belongs to the child, not the parent, and the quote is not ended
    fail if: `Gamma` is a third span, `Gamma` is inside `0-9`, or the child shows a `>`

48. an equal item without `>` ends the quoted item and the quote
    source: `> - Alpha\n- Beta\n` (length 17)
    spans: quoted item `0-9` `> - Alpha\n`; item `10-16` `- Beta\n`
    display: bar, marker `-`, prose `Alpha`. Then marker `-`, prose `Beta`, no bar
    second: may hold `10-16` while `0-9` is held
    expect: two spans
    fail if: `- Beta` stays inside the quote, or one span

49. list continuation until the next item
    source: `- Alpha\nBeta\n- Gamma\n` (length 21)
    spans: item `0-12` `- Alpha\nBeta\n`; item `13-20` `- Gamma\n`
    display: marker `-` once, prose `Alpha` ␣@7 `Beta`. Then marker `-` once, prose `Gamma`
    second: may replace `Gamma` with `Delta` while the first item is held. Caret on `Beta` (offset 8) returns 409
    expect: `Beta` is not its own paragraph
    fail if: three spans, or a second marker on `Beta`

50. a blank ends a list item
    source: `- Alpha\n\nBeta\n` (length 14)
    spans: item `0-7` `- Alpha\n`; blank `8-8`; `9-13` `Beta\n`
    display: marker `-`, prose `Alpha`; empty; prose `Beta` with no marker
    second: may replace `Beta` with `Gamma` while the item is held
    expect: `Beta` is a paragraph
    fail if: `Beta` stays in the item span

51. a heading ends a list item
    source: `- Alpha\n# H\n` (length 12)
    spans: item `0-7` `- Alpha\n`; heading `8-11` `# H\n`
    display: marker `-`, prose `Alpha`; level-1 `H`
    second: may hold the heading while the item is held
    expect: two spans. A hunk that changes `- Alpha` and `# H` together, to `- Alpha!` and `# H!`, is applied: `- Alpha!\n# H!\n`
    fail if: the heading is continuation text

52. a rule ends a list item
    source: `- Alpha\n---\nBeta\n` (length 17)
    spans: item `0-7` `- Alpha\n`; hr `8-11` `---\n`; `12-16` `Beta\n`
    display: marker `-`, prose `Alpha`; a rule; prose `Beta` with no marker
    second: may hold `Beta` while the item is held
    expect: three spans
    fail if: `Beta` continues the item across the rule

53. a fence ends a list item
    source: `- Alpha\n```js\nx\n```\n` (length 20)
    spans: item `0-7` `- Alpha\n`; fence `8-19`
    display: marker `-`, prose `Alpha`; one code block, body `x`, newline preserved
    second: may hold the fence while the item is held
    expect: two spans
    fail if: `x` continues the item as `Alpha x`

54. a table ends a list item
    source: `- Alpha\n| a |\n| --- |\n| 1 |\n` (length 28)
    spans: item `0-7` `- Alpha\n`; header `8-21` `| a |\n| --- |\n`; body `22-27` `| 1 |\n`
    display: the item `Alpha`; then a table whose header cell is `a` and whose one body cell is `1`. The delimiter is not a body row and not its own span
    second: may hold the body row while the item is held, and may hold the header while the body row is held
    expect: three spans. A hunk with `| --- |` and `| 1 |` as old lines that changes the body cell to `2` is applied: `- Alpha\n| a |\n| --- |\n| 2 |\n`. So is a hunk with `| a |` and `| --- |` as old lines that changes the header cell to `b`: `- Alpha\n| b |\n| --- |\n| 1 |\n`
    fail if: the item swallows the table, or the delimiter is a third lock separate from the header

55. parent, continuation, child, and a line after the child
    source: `- Alpha\n  continues\n  - Beta\n  after\n- Gamma\n` (length 45)
    spans: item `0-19` `- Alpha\n  continues\n`; child `20-36` `  - Beta\n  after\n`; item `37-44` `- Gamma\n`
    display: marker `-`, prose `Alpha` ␣@7 `  continues` (the two spaces at 8 and 9 stay). Indented marker `-`, prose `Beta` ␣@28 `  after` (the two spaces on that continuation stay). Marker `-`, prose `Gamma`
    second: may replace `after` while `Alpha` is held. Must not lock the child by holding the parent. A hunk that changes `  continues` and `  - Beta` together, to `  continued` and `  - Beta!`, is applied: `- Alpha\n  continued\n  - Beta!\n  after\n- Gamma\n`
    expect: `after` is in the child span. The parent does not resume
    fail if: `after` is in the parent span, the parent range covers `Beta`, or one span wraps the whole list

56. equal and lesser indents
    source: `- a\n  - b\n    - c\n  - d\n- e\n` (length 28)
    spans: `0-3` `- a\n`; `4-9` `  - b\n`; `10-17` `    - c\n`; `18-23` `  - d\n`; `24-27` `- e\n`
    display: five item blocks, markers once each, prose `a`, `b`, `c`, `d`, `e`
    second: may hold `d` while `b` is held, and `e` while `a` is held
    expect: `d` ends both `c` and `b`. `e` ends `a`. Five spans
    fail if: `c` includes `d`, or `b` includes `d`

57. a tab item and a four-space item are the same indent
    source: `- a\n\t- b\n    - c\n` (length 17)
    spans: `0-3` `- a\n`; `4-8` `\t- b\n`; `9-16` `    - c\n`
    display: three items, prose `a`, `b`, `c`
    second: may hold `c` while `b` is held
    expect: `c` ends `b` because both markers sit at column 4
    fail if: `c` is a child of `b`, or the tab is prose

58. ordered continuation and a parenthesis marker
    source: `1. Alpha\n2 next\n1) Beta\n` (length 24)
    spans: item `0-15` `1. Alpha\n2 next\n`; item `16-23` `1) Beta\n`
    display: marker `1.` once, prose `Alpha` ␣@8 `2 next`. Then marker `1)`, prose `Beta`
    second: may hold `1) Beta` while the first item is held. Caret on `2` returns 409
    expect: `2 next` is continuation, not an item
    fail if: three spans, or a marker `2` is shown

59. ten digits are not an ordered item
    source: `1234567890. no\n` (length 15)
    spans: `0-14` `1234567890. no\n`
    display: prose `1234567890. no`, no list marker
    second: no other span
    expect: one `p` span
    fail if: the digits are taken as a marker and the prose is only `no`

60. a dash without a separator is prose
    source: `-Alpha\nstill\n` (length 13)
    spans: `0-12` `-Alpha\nstill\n`
    display: `-Alpha` ␣@6 `still`. The dash is visible. No list marker
    second: no other span
    expect: one paragraph
    fail if: a list span

61. `+` and `*` markers
    source: `+ Alpha\nBeta\n` (length 13) and `* Alpha\nBeta\n` (length 13)
    spans: each source is one item `0-12`
    display: marker `+` once, prose `Alpha` ␣@7 `Beta`. Marker `*` once, prose `Alpha` ␣@7 `Beta`
    second: caret on `Beta` returns 409 for that source
    expect: the same shape as a `-` item
    fail if: either line is a paragraph, or `*` opens a rule

62. empty item
    source: `- \n` (length 3)
    spans: item `0-2` `- \n`
    display: marker `-` once, empty prose
    second: no other span
    expect: one item span
    fail if: a blank span, or the separator space is shown as prose

63. hard break inside an item
    source: `- alpha  \nbeta\n` (length 15)
    spans: item `0-14` `- alpha  \nbeta\n`
    display: marker `-` once, then `alpha` ⏎@9 `beta`. No second marker
    second: caret on `beta` returns 409
    expect: one item, one hard break
    fail if: the display is `alpha beta`, or two spans

64. code fence
    source: "```js\nlet x\n```\n" (length 16)
    spans: fence `0-15` "```js\nlet x\n```\n"
    display: one code block. Body text `let x`. The newline at 11 stays a newline and does not map as a space. The space in `let x` is the source space at 9
    second: no other span. A second lock returns 409
    expect: one span from the opening line through the closing line
    fail if: three line spans, or the body newline displays as a space

65. caret inside a fence
    source: "```js\nlet x\n```\n" (length 16)
    spans: fence `0-15`, caret at the `x` (offset 10) included
    display: the lock span stays `0-15`. The block may show source while the caret is inside; it may not become one span per source line
    second: a caret on the closer while offset 10 is held returns 409
    expect: one fence span
    fail if: the caret's line is the only locked range

66. unclosed code fence
    source: "```js\nlet x" (length 11)
    spans: fence `0-10` "```js\nlet x"
    display: one unclosed code block, body `let x`
    second: no other span
    expect: one span through EOF
    fail if: `let x` is a paragraph span

67. fence with an empty info string
    source: "```\ncode\n```\n" (length 13)
    spans: fence `0-12`
    display: one code block, body `code`, newline preserved
    second: no other span
    expect: one code span, not a diagram and not a comment
    fail if: more than one span

68. mermaid fence
    source: "```mermaid\ngraph TD\nA-->B\n```\n" (length 30)
    spans: fence `0-29`
    display: one diagram block. Body newlines stay newlines. The body does not display as `graph TD A-->B`
    second: no other span
    expect: one span from the opener through the closer
    fail if: the body is a wrapped paragraph, or the fence is split by line

69. `Mermaid` is code
    source: "```Mermaid\ngraph TD\n```\n" (length 24)
    spans: fence `0-23`
    display: one code block, body `graph TD`, not a drawn diagram
    second: no other span
    expect: one code span
    fail if: a diagram is drawn

70. a fence between paragraphs
    source: `words\n```js\nx\n```\nmore\n` (length 23)
    spans: `0-5` `words\n`; fence `6-17`; `18-22` `more\n`
    display: `words`; code `x`; `more`. No joining spaces
    second: may replace `more` with `less` while `words` is held, and may hold the fence while `words` is held
    expect: three spans. A hunk that changes `words` to `words!`, with the fence's opening line as an old line, is applied: "words!\n```js\nx\n```\nmore\n"
    fail if: one paragraph spans the fence

71. comment fence
    source: "```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nThis note is the start of the thread.\n:: 1\n@2026-10-05T16:05:00.000Z Bea\nA reply keeps its own author line.\n```\n" (length 161)
    spans: opener `0-13`; note `14-86` (from `:: 0` through the newline before `:: 1`); note `87-156` (from `:: 1` through the newline before the closer); closer `157-160`
    display: four blocks. The first note's block contains `This note is the start of the thread.` and does not contain `A reply keeps its own author line.` Newlines inside a note stay newlines
    second: may replace `A reply keeps its own author line.` while the `14-86` note is held. The author line of note 0 stays inside `14-86`; it is not its own span, and this case does not decide authorship
    expect: opener, one span per note, closer
    fail if: the whole fence is one span, the author line is a span, or the two notes wrap into one paragraph

72. a hunk that merges or splits comment notes
    source: the step 71 string
    spans: the step 71 spans
    display: unchanged on rejection
    second: not granted a lock
    expect: a hunk with the context line `This note is the start of the thread.` that removes the `:: 1` line returns 409, and so does one that adds `:: 2` after that line. The bytes are identical, and no lock is taken (ticket `hnbdeuu8`)
    fail if: either hunk is written, or the thread's notes change

73. a bare `::` starts a note
    source: "```comment c1\n:: 0\nfirst\n::\nsecond\n```\n" (length 39)
    spans: opener `0-13`; note `14-24`; note `25-34`; closer `35-38`
    display: the first note contains `first` and not `second`. The second note contains `second`
    second: may replace `second` while `first` is held
    expect: the bare `::` line starts the second note span
    fail if: `::` stays inside the first note

74. `:: 01` and `:: 1 ` do not split
    source: "```comment c1\n:: 0\nsee\n:: 01\n:: 1 \nend\n```\n" (length 43)
    spans: opener `0-13`; note `14-38`; closer `39-42`
    display: one note block whose span contains the lines `:: 01` and `:: 1 ` as text
    second: may hold the closer while the note is held. A lock of only `:: 01` returns 409
    expect: one note span
    fail if: three note spans

75. duplicate note ids are still two spans
    source: "```comment c1\n:: 1\none\n:: 1\ntwo\n```\n" (length 36)
    spans: opener `0-13`; note `14-22`; note `23-31`; closer `32-35`
    display: one block contains `one` and not `two`; the next contains `two`
    second: may replace `two` while `one` is held
    expect: two note spans despite the repeated id
    fail if: one note span, or authorship is required to decide the split

76. comment with no notes
    source: "```comment c1\n```\n" (length 18)
    spans: opener `0-13`; closer `14-17`
    display: the fence edges, no note block
    second: may hold the closer while the opener is held
    expect: two spans and `parseCommentNotes` of the empty body has nothing to lock
    fail if: a vacant note span is inserted between them

77. unclosed comment
    source: "```comment c1\n:: 0\nnote" (length 23)
    spans: opener `0-13`; note `14-22` `:: 0\nnote`
    display: one note block containing `note`. No closer block
    second: may hold the opener while the note is held. The note bytes stay `:: 0\nnote`
    expect: no closer span
    fail if: `note` is outside the note span, or a closer is invented

78. table rows
    source: `| Mark | Drawn |\n| --- | --- |\n| Bold | yes |\n| Em | no |\n` (length 58)
    spans: header `0-30`; body `31-45` `| Bold | yes |\n`; body `46-57` `| Em | no |\n`
    display: one table. Header cells `Mark` and `Drawn`. Body rows `Bold`/`yes` and `Em`/`no`. The delimiter is not a displayed body row
    second: may replace `yes` with `no` while the header is held, and may hold `46-57` while `31-45` is held. A second lock of `31-45` returns 409
    expect: header plus delimiter is one span; each body row is its own
    fail if: the delimiter is its own span, or both body rows are one span

79. aligned delimiter stays in the header span
    source: `| a | b |\n| :--- | ---: |\n| 1 | 2 |\n` (length 36)
    spans: header `0-25`; body `26-35` `| 1 | 2 |\n`
    display: header cells `a` and `b`; one body row `1` and `2`
    second: may hold the body while the header is held
    expect: the `:---` row is the delimiter half of the header span
    fail if: that row is a body span

80. a pipe line without a delimiter is a paragraph
    source: `| Mark | Drawn |\nnot a table\n` (length 29)
    spans: `0-28`
    display: `| Mark | Drawn |` ␣@16 `not a table`
    second: no other span
    expect: one paragraph. `isTableStart` is false
    fail if: a table span

81. a blank ends a table
    source: `| a |\n| --- |\n| 1 |\n\n| 2 |\n` (length 27)
    spans: header `0-13`; body `14-19` `| 1 |\n`; blank `20-20`; paragraph `21-26` `| 2 |\n`
    display: a table with header `a` and body `1`; an empty block; a paragraph whose prose is `| 2 |`, not a table cell
    second: may replace `| 2 |` while the body row is held
    expect: the later pipe line is not a body row
    fail if: `| 2 |` is a second body span of the same table

82. an image has no span
    source: `See ![alt](u)\nhere.\n` (length 20)
    spans: `0-19` only. The image syntax is `4-12` and is not a span
    display: one block, prose `See `, the image alt `alt` url `u`, ␣@13, prose `here.`
    second: caret in the image (offset 4) locks `0-19`. A second caret on `here.` (offset 14) returns 409. There is no image lock that leaves `See` editable
    expect: one paragraph span, bytes unchanged
    fail if: a span whose range is only `![alt](u)`, or two spans split at the newline

83. an image line is a paragraph span
    source: `Before\n\n![alt](sample.svg)\n\nAfter\n` (length 34)
    spans: `0-6` `Before\n`; blank `7-7`; `8-26` `![alt](sample.svg)\n`; blank `27-27`; `28-33` `After\n`
    display: `Before`; empty; one image, alt `alt`, url `sample.svg`, inside that paragraph block; empty; `After`
    second: may replace `After` with `Later` while `8-26` is held. Must not be given a span that is only `![alt](sample.svg)` (`8-25`) with the newline at 26 left over
    expect: five spans, none of them an image span. The image line is present
    fail if: the image line is omitted, or a sixth span covers only the image syntax

84. visual wrap does not change bytes
    source: `The caret can travel to the end of this raw line while the pane wraps the text.\n` (length 80)
    spans: `0-79`
    display: one paragraph. A narrow wrap may break the line on screen. Those screen breaks are not source newlines and are not span boundaries. The newline at 79 is the terminator and is not a joining space
    second: no other span
    expect: after the wrapped block is built, the string is still that source
    fail if: a space or newline is inserted, or a visual wrap point is a second span

85. a hunk inside one paragraph may span its newline
    source: `aa\nbb\n\ncc\ndd\n` (length 13)
    spans: `0-5` `aa\nbb\n`; blank `6-6`; `7-12` `cc\ndd\n`
    display: `aa` ␣@2 `bb`; empty; `cc` ␣@9 `dd`
    second: may hold `7-12` during this edit
    expect: a hunk that changes `aa` and `bb` to `AA` and `BB` is applied. Bytes become `AA\nBB\n\ncc\ndd\n`. The blank and `cc\ndd\n` are unchanged. The first block displays `AA` ␣ `BB`
    fail if: 409, or `cc\ndd` changes

86. a hunk across a blank is applied
    source: `aa\nbb\n\ncc\ndd\n` (length 13)
    spans: `0-5`; blank `6-6`; `7-12`
    display: after the edit, one block: `aa` ␣@2 `bbcc` ␣@7 `dd`
    second: none
    expect: a hunk that replaces `bb`, the blank line, and `cc` with `bbcc` is applied. Bytes become `aa\nbbcc\ndd\n`, one paragraph
    fail if: 409, or the result is not one paragraph

87. the two newlines at a paragraph boundary are not one span
    source: `aa\nbb\n\ncc\ndd\n` (length 13)
    spans: newline 5 is inside `0-5`. Newline 6 is the blank span
    display: after the edit, one block: `aa` ␣@2 `bb` ␣@5 `cc` ␣@8 `dd`
    second: none
    expect: a hunk that removes the blank line between `bb` and `cc` is applied, although it crosses from `0-5` into the blank span and on to `7-12`. Bytes become `aa\nbb\ncc\ndd\n`, one paragraph
    fail if: 409, or the two paragraphs stay apart

88. two editors write two spans
    source: `aa\nbb\n\ncc\ndd\n` (length 13)
    spans: `0-5` and `7-12`, blank `6-6` left untouched
    display: after both writes, `AA` ␣ `bb` and `CC` ␣ `dd`
    second: B holds `7-12` while A holds `0-5`. A replaces `aa` with `AA`. B replaces `cc` with `CC`. Both writes succeed
    expect: bytes `AA\nbb\n\nCC\ndd\n`. Neither editor receives 409 because the other span changed
    fail if: B's write is 409, or either replacement is missing

89. the second editor cannot take a held span
    source: `aa\nbb\n\ncc\ndd\n` (length 13)
    spans: `0-5` held by A from caret 0. B already holds `7-12`
    display: unchanged
    second: B's caret at 3 returns 409. A still holds `0-5`. B still holds `7-12`. Bytes unchanged
    expect: one span, one holder
    fail if: B is added to `0-5`, or A's hold is dropped

90. partition
    source: every source string in steps 1–89
    spans: the spans listed on that step
    display: not this step
    second: not this step
    expect: for every non-empty source, the inclusive spans are ordered, non-overlapping, and their union is `0` through `length - 1`. The empty source stays the vacant span. No span starts at `length`
    fail if: a character is in two spans, a character is in none, or a phantom tail span exists
