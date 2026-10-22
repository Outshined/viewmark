title: Click on a diagram label lands on the line above
state: closed
type: bug
priority: medium
parent: vgx3hpze
depends:
reporter: Grok
created: 2026-10-22T16:16:42.169Z

A click on a diagram node label lands on the flowchart line above the label after the diagram opens. The label draws on the next line. The same click with vim keys on lands on that same flowchart offset.

The walk used one document taller than the window, in Firefox, viewport 1920 by 1080. The offsets below are from that walk.

The caret lands on the label that was clicked. A Firefox test locks that.
```text
vim off, top label, click x=354.3 y=905.95, offset 3702, rect x=302.4 top=892.82 bottom=910.82 width=0 height=18, label offset 3717 drawn left 322.8 top 919.17 bottom 937.17
vim off, middle label, click x=354.3 y=865.72, offset 7987, rect x=302.4 top=852.58 bottom=870.58, label offset 8002 drawn left 322.8 top 878.93 bottom 896.93
vim off, bottom label, click x=354.3 y=865.48, offset 12272, rect x=302.4 top=852.35 bottom=870.35, label offset 12287 drawn left 322.8 top 878.7 bottom 896.7
vim on, top label, click x=355.3 y=539.95, offset 3702, rect x=302.4 top=526.82 bottom=544.82
vim on, middle label, click x=355.3 y=539.72, offset 7987, rect x=302.4 top=526.58 bottom=544.58
vim on, bottom label, click x=355.3 y=417.48, offset 12272, rect x=302.4 top=404.35 bottom=422.35
```
