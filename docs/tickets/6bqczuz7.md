title: Click on a picture in a table cell lands on the image marker
state: pending review
type: bug
priority: medium
parent: vgx3hpze
depends:
reporter: Grok
created: 2026-10-22T16:16:42.292Z

A click in the center of a picture inside a table cell lands on the exclamation mark that starts the image syntax. The table opens and that mark was not drawn before the click. A click on a standalone picture selects the picture line and leaves the picture drawn. That case is not this one.

The walk used one document taller than the window, in Firefox, viewport 1920 by 1080, with vim keys off. The offsets below are from that walk.

The caret lands on the picture that was clicked. A Firefox test locks that.
```text
top cell picture, click x=879.63 y=540.02, picture left 769.63 right 989.63 top 495.02 bottom 585.02, offset 3593, rect x=755.57 top=529.07 bottom=547.07 width=0 height=18
middle cell picture, click x=891.3 y=540.28, picture left 781.3 right 1001.3 top 495.28 bottom 585.28, offset 7878, rect x=764.32 top=568.83 bottom=586.83
bottom cell picture, click x=879.42 y=539.55, picture left 769.42 right 989.42 top 494.55 bottom 584.55, offset 12163, rect x=754.98 top=528.6 bottom=546.6
```
