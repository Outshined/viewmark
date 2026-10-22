title: Assaholic QA
state: closed
type: bug
priority: medium
parent:
depends:
reporter: Grok
created: 2026-10-22T15:24:43.269Z

Caret walk on one document taller than the window, Firefox under cage, viewport 1920 by 1080. With the middle heading on screen, the top heading sat above the window and the bottom heading sat below it. Arrow keys traveled from the top band through the bottom band and back, so the window scrolled both ways. Vim keys off, then the same arrow walk with vim keys on. Each row below is one key or click: source offset and the selection client rect.

## Caret vanishes on a newline the page does not draw
ArrowDown from the open top heading stops on the blank line between that heading and the table. The selection rect is a 0 by 0 box at the viewport origin, so no caret is visible. The line box for that blank is on screen. The next ArrowDown reaches the table and is visible. The same invisible stop happens after the middle heading and the bottom heading, going down and coming up, with vim keys off and on. ArrowLeft off an open heading, and ArrowDown from the paragraph above a heading, stop on the blank line before that heading with the same origin rect. ArrowDown off the last code line of a fence stops on the newline after that line, before the closing fence line, again with an origin rect. End on an open fence, and ArrowLeft off the first code line, stop on the newline after the info word of the opener. Home on that opener is visible. With vim keys on, ArrowLeft stops on the first letter of the function line and does not step onto that newline.
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
A person expects one visible step onto the next drawn line. End stays on the last drawn glyph of the opener.

## Vim Home from a standalone picture jumps to the last paragraph
Vim keys on. A click on the standalone picture selects that line and the caret is visible at the end of it. ArrowLeft collapses onto the newline after the picture and the selection rect becomes the origin. ArrowRight stays on that newline, still with no rect. Home then jumps to the last paragraph of the document. The middle picture and the bottom picture take the same jump. With vim keys off, Home on that image line stays on the line.
```text
vim on, click top picture, anchor 3660, focus 3690, rect x=531.83 top=373.93 bottom=391.93 width=0 height=18, scrollY 897
vim on, ArrowLeft, offset 3690, rect x=0 top=0 bottom=0 width=0 height=0, scrollY 897
vim on, ArrowRight, offset 3690, rect x=0 top=0 bottom=0 width=0 height=0, scrollY 897
vim on, Home, offset 14083, rect x=302.4 top=1036.08 bottom=1054.08, scrollY 4122, last paragraph
vim on, End, offset 14326, rect x=1050.83 top=1062.43 bottom=1080.43, scrollY 4122
vim on, click middle picture, anchor 7945, focus 7975, rect x=531.83 top=787.7 bottom=805.7, scrollY 2078
vim on, ArrowLeft, offset 7975, rect x=0 top=0 bottom=0, scrollY 2078
vim on, Home, offset 14083, rect x=302.4 top=1036.08 bottom=1054.08, scrollY 4122
vim on, click bottom picture, anchor 12230, focus 12260, rect x=531.83 top=787.47 bottom=805.47, scrollY 3673
vim on, ArrowLeft, offset 12260, rect x=0 top=0 bottom=0, scrollY 3673
vim on, Home, offset 14083, rect x=302.4 top=1036.08 bottom=1054.08, scrollY 4122
vim off, Home on top picture line, offset 3660, rect x=302.4 top=719.1 bottom=737.1, scrollY 484
```
A person expects Home to stay on the picture line, at its start.

## Click on a heading drawn in a table cell lands on the hashes
Vim keys off. The click is on the drawn letter of the heading in the first cell. After the table opens, the caret is on the first hash. That hash was not drawn before the click. The word that was clicked draws about 24px to the right of the caret. Clicks on the list word, the quote word, and the code word in the same cells landed on those words.
```text
top cell heading, click x=313.75 y=677.12, offset 3539, rect x=318.53 top=678.07 bottom=696.07 width=0 height=18, word offset 3542 drawn left 342.08 top 678.07
middle cell heading, click x=313.75 y=636.88, offset 7824, rect x=318.53 top=637.83 bottom=655.83, word offset 7827 drawn left 342.08 top 637.83
bottom cell heading, click x=313.75 y=636.65, offset 12109, rect x=318.53 top=637.6 bottom=655.6, word offset 12112 drawn left 342.08 top 637.6
```
A person expects the caret on the letter that was clicked.

## Click on a diagram label lands one line above the label
The click is on the node label. After the diagram opens, the caret is on the flowchart line, and the label draws on the next line. The same click with vim keys on lands on that same flowchart offset.
```text
vim off, top label, click x=354.3 y=905.95, offset 3702, rect x=302.4 top=892.82 bottom=910.82 width=0 height=18, label offset 3717 drawn left 322.8 top 919.17 bottom 937.17
vim off, middle label, click x=354.3 y=865.72, offset 7987, rect x=302.4 top=852.58 bottom=870.58, label offset 8002 drawn left 322.8 top 878.93 bottom 896.93
vim off, bottom label, click x=354.3 y=865.48, offset 12272, rect x=302.4 top=852.35 bottom=870.35, label offset 12287 drawn left 322.8 top 878.7 bottom 896.7
vim on, top label, click x=355.3 y=539.95, offset 3702, rect x=302.4 top=526.82 bottom=544.82
vim on, middle label, click x=355.3 y=539.72, offset 7987, rect x=302.4 top=526.58 bottom=544.58
vim on, bottom label, click x=355.3 y=417.48, offset 12272, rect x=302.4 top=404.35 bottom=422.35
```
A person expects the caret on the label that was clicked.

## Click on a picture inside a table cell lands on the image marker
Vim keys off. The click is the center of the picture in a cell. The table opens and the caret sits on the exclamation mark that starts the image syntax, left of the picture that was clicked. That mark was not drawn before the click. A click on a standalone picture selects the picture line and leaves the picture drawn; that case is not this one.
```text
top cell picture, click x=879.63 y=540.02, picture left 769.63 right 989.63 top 495.02 bottom 585.02, offset 3593, rect x=755.57 top=529.07 bottom=547.07 width=0 height=18
middle cell picture, click x=891.3 y=540.28, picture left 781.3 right 1001.3 top 495.28 bottom 585.28, offset 7878, rect x=764.32 top=568.83 bottom=586.83
bottom cell picture, click x=879.42 y=539.55, picture left 769.42 right 989.42 top 494.55 bottom 584.55, offset 12163, rect x=754.98 top=528.6 bottom=546.6
```
A person expects the caret on the picture that was clicked.

## {c1}Caret draws under the path strip{/c1}
On the way up the window has scrolled, and ArrowUp parks the caret on a line whose client rect is above the bottom of the path strip. The strip bottom in this walk was 39.2. The caret is covered. The same cover hits paragraph starts, fence lines, and a heading that has just opened. Ticket bkmujvq5 recorded this cover and is closed. These rows are the offset and rect from this walk.
```text
vim off, ArrowUp, middle fence return line, offset 8057, rect x=302.4 top=-0.4 bottom=17.6 width=0 height=18, scrollY 3063
vim off, ArrowUp, paragraph start, offset 11771, rect x=302.4 top=0.38 bottom=18.38, scrollY 4090
vim off, ArrowUp, paragraph start, offset 11524, rect x=302.4 top=4.5 bottom=22.5, scrollY 4020
vim off, ArrowUp, paragraph start, offset 11277, rect x=302.4 top=4.62 bottom=22.62, scrollY 3954
vim off, ArrowUp, paragraph start, offset 11030, rect x=302.4 top=3.73 bottom=21.73, scrollY 3889
vim off, ArrowUp, paragraph start, offset 10783, rect x=302.4 top=3.85 bottom=21.85, scrollY 3823
vim off, ArrowUp, paragraph start, offset 10536, rect x=302.4 top=3.97 bottom=21.97, scrollY 3757
vim off, ArrowUp, paragraph start, offset 10290, rect x=302.4 top=4.08 bottom=22.08, scrollY 3691
vim off, ArrowUp, paragraph start, offset 10044, rect x=302.4 top=4.2 bottom=22.2, scrollY 3625
vim off, ArrowUp, paragraph start, offset 9798, rect x=302.4 top=4.32 bottom=22.32, scrollY 3559
vim off, ArrowUp, paragraph start, offset 9552, rect x=302.4 top=4.43 bottom=22.43, scrollY 3493
vim off, ArrowUp, paragraph start, offset 9306, rect x=302.4 top=4.55 bottom=22.55, scrollY 3427
vim off, ArrowUp, paragraph start, offset 9060, rect x=302.4 top=3.67 bottom=21.67, scrollY 3362
vim off, ArrowUp, paragraph start, offset 8814, rect x=302.4 top=3.78 bottom=21.78, scrollY 3296
vim off, ArrowUp, paragraph start, offset 8568, rect x=302.4 top=3.9 bottom=21.9, scrollY 3230
vim off, ArrowUp, paragraph start, offset 8322, rect x=302.4 top=4.02 bottom=22.02, scrollY 3164
vim off, ArrowUp, paragraph start, offset 8076, rect x=302.4 top=4.13 bottom=22.13, scrollY 3098
vim off, ArrowUp, middle fence opener line, offset 8035, rect x=302.4 top=0.25 bottom=18.25, scrollY 3036
vim off, ArrowUp, top fence return line, offset 3772, rect x=302.4 top=-0.17 bottom=17.83, scrollY 1468
vim on, ArrowUp, middle fence closing brace, offset 8069, rect x=302.4 top=3.95 bottom=21.95, scrollY 3085
vim on, ArrowUp, top fence closing brace, offset 3784, rect x=302.4 top=4.18 bottom=22.18, scrollY 1490
vim off, ArrowUp, bottom heading just opened, offset 12021, rect x=334.87 top=31.67 bottom=56.67 width=0 height=25, scrollY 4123
vim on, ArrowUp, bottom heading just opened, offset 12021, rect x=334.87 top=31.67 bottom=56.67, scrollY 4123
```
A person expects the caret below the path strip, where it can be seen.

```comment c1
:: 0
@2026-10-22T16:11:56.970Z Operator
I believe this was already addressed while QA was in flight.
```
