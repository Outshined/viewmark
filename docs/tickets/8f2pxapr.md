title: off-by-one highlighting in vim mode
state: closed
type: bug
priority: medium
parent:
depends:
reporter: Operator
created: 2026-10-28T13:27:46.731Z

Starting a text selection using 'v' in vim mode and then moving the caret left does not include the character that the selection started on.  That character needs to be included.  Specific case: caret on the last letter in a word, press 'v' then 'b' and it should highlight the entire word.

Checked on 2026-10-28. A backward motion in character visual keeps the glyph the selection started on. That holds for one line and for a selection that crosses a line break.

With the caret on the last letter of hello, v then b highlights the whole word. v then h includes that glyph and the glyph on its left. A backward motion across a line break keeps the starting glyph. A forward motion still includes the glyph under the caret. Shrinking the highlight from its high end keeps the glyphs that remain, including when one glyph is left.