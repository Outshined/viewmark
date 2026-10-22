title: Caret vanishes on an undrawn newline
state: pending review
type: bug
priority: medium
parent: vgx3hpze
depends:
reporter: Grok
created: 2026-10-22T16:16:41.778Z

Arrow motion stops on a newline the page does not draw. The selection rect is a 0 by 0 box at the viewport origin, so no caret is visible. The next step that reaches a drawn line is visible.

This happens on the blank line before and after a heading, going down and coming up, with vim keys off and on. ArrowLeft off an open heading stops on the blank line before that heading. ArrowDown off the last code line of a fence stops on the newline after that line, before the closing fence line. End on an open fence, and ArrowLeft off the first code line, stop on the newline after the info word of the opener. Home on that opener is visible. With vim keys on, ArrowLeft stops on the first letter of the function line and does not step onto that newline.

The walk used one document taller than the window, in Firefox, viewport 1920 by 1080. The offsets below are from that walk.

A step lands on the next drawn line, and the caret rect is on that line. End stays on the last drawn glyph of the opener. A Firefox test locks that.
```text
vim off, click top heading, offset 3451, rect x=334.87 top=521.13 bottom=546.13 width=0 height=25, scrollY 444, caret on the heading word
vim off, ArrowDown, offset 3464, rect x=0 top=0 bottom=0 width=0 height=0, scrollY 444, blank line before the table
vim off, ArrowDown, offset 3465, rect x=302.4 top=599 bottom=617 width=0 height=18, scrollY 444, first cell of the table
vim on, click top heading, offset 3451, rect x=334.87 top=520.57 bottom=545.57, scrollY 444.57
vim on, ArrowDown, offset 3464, rect x=0 top=0 bottom=0 width=0 height=0, scrollY 444.57
vim off, ArrowDown after middle heading, offset 7749, rect x=0 top=0 bottom=0, scrollY 1554
vim off, ArrowDown after bottom heading, offset 12034, rect x=0 top=0 bottom=0, scrollY 3148
vim off, ArrowUp onto blank after bottom heading, offset 12034, rect x=0 top=0 bottom=0, scrollY 4123
vim off, ArrowUp onto blank before bottom heading, offset 12017, rect x=0 top=0 bottom=0, scrollY 4123
vim off, ArrowUp onto blank after middle heading, offset 7749, rect x=0 top=0 bottom=0, scrollY 2607
vim off, ArrowUp onto blank before middle heading, offset 7732, rect x=0 top=0 bottom=0, scrollY 2557
vim off, ArrowUp onto blank after top heading, offset 3464, rect x=0 top=0 bottom=0, scrollY 1012
vim off, ArrowUp onto blank before top heading, offset 3447, rect x=0 top=0 bottom=0, scrollY 963
vim off, ArrowLeft off top heading, offset 3447, rect x=0 top=0 bottom=0, scrollY 484
vim off, ArrowLeft off middle heading, offset 7732, rect x=0 top=0 bottom=0, scrollY 2078
vim off, ArrowLeft off bottom heading, offset 12017, rect x=0 top=0 bottom=0, scrollY 3673
vim on, ArrowDown blank after middle heading, offset 7749, rect x=0 top=0 bottom=0, scrollY 1553.57
vim on, ArrowDown blank after bottom heading, offset 12034, rect x=0 top=0 bottom=0, scrollY 3148.57
vim on, ArrowUp blank after bottom heading, offset 12034, rect x=0 top=0 bottom=0, scrollY 4123
vim on, ArrowUp blank after middle heading, offset 7749, rect x=0 top=0 bottom=0, scrollY 2607
vim on, ArrowUp blank after top heading, offset 3464, rect x=0 top=0 bottom=0, scrollY 1012
vim off, ArrowDown newline after last top fence code line, offset 3785, rect x=0 top=0 bottom=0, scrollY 444
vim off, ArrowDown newline after last middle fence code line, offset 8070, rect x=0 top=0 bottom=0, scrollY 2031
vim off, ArrowUp newline after last bottom fence code line, offset 12355, rect x=0 top=0 bottom=0, scrollY 4191
vim off, ArrowUp newline after last middle fence code line, offset 8070, rect x=0 top=0 bottom=0, scrollY 3085
vim off, ArrowUp newline after last top fence code line, offset 3785, rect x=0 top=0 bottom=0, scrollY 1490
vim off, Home on top fence opener, offset 3736, rect x=302.4 top=931.13 bottom=949.13, scrollY 484
vim off, End on top fence opener, offset 3749, rect x=0 top=0 bottom=0, scrollY 484, newline after the info word
vim off, ArrowLeft onto that newline, offset 3749, rect x=0 top=0 bottom=0, scrollY 484
vim off, End on middle fence opener, offset 8034, rect x=0 top=0 bottom=0, scrollY 2078
vim off, End on bottom fence opener, offset 12319, rect x=0 top=0 bottom=0, scrollY 3673
```
