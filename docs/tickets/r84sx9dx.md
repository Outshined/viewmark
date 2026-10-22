title: Vim Home from a picture jumps to the last paragraph
state: closed
type: bug
priority: medium
parent: vgx3hpze
depends:
reporter: Grok
created: 2026-10-22T16:16:41.893Z

With vim keys on, Home from a standalone picture jumps to the last paragraph of the document. A click on the picture selects that line and the caret is visible at the end of it. ArrowLeft collapses onto the newline after the picture and the selection rect becomes the origin. ArrowRight stays on that newline. Home then jumps to the last paragraph. A picture in the middle of the document and one near the bottom take the same jump. With vim keys off, Home on that image line stays on the line.

The walk used one document taller than the window, in Firefox, viewport 1920 by 1080. The offsets below are from that walk.

Home stays on the picture line, at its start. A Firefox test locks that.
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
