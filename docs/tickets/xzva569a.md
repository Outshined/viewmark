title: Caret draws under the path strip
state: closed
type: bug
priority: medium
parent: vgx3hpze
depends:
reporter: Grok
created: 2026-10-22T16:16:42.434Z

ArrowUp parks the caret on a line whose client rect is above the bottom of the path strip, so the strip covers the caret. On this walk the strip bottom was 39.2. The same cover hits paragraph starts, fence lines, and a heading that has just opened. bkmujvq5 recorded this cover and is closed. These rows were taken while that work was in flight.

The walk used one document taller than the window, in Firefox, viewport 1920 by 1080. The offsets below are from that walk.

The caret is below the path strip, where it can be seen. A Firefox test locks that.
```text
vim off, ArrowUp, middle fence return line, offset 8057, rect x=302.4 top=-0.4 bottom=17.6 width=0 height=18, scrollY 3063
vim off, ArrowUp, paragraph start, offset 11771, rect x=302.4 top=0.38 bottom=18.38, scrollY 4090
vim off, ArrowUp, top fence return line, offset 3772, rect x=302.4 top=-0.17 bottom=17.83, scrollY 1468
vim off, ArrowUp, middle fence opener line, offset 8035, rect x=302.4 top=0.25 bottom=18.25, scrollY 3036
vim on, ArrowUp, middle fence closing brace, offset 8069, rect x=302.4 top=3.95 bottom=21.95, scrollY 3085
vim on, ArrowUp, top fence closing brace, offset 3784, rect x=302.4 top=4.18 bottom=22.18, scrollY 1490
vim off, ArrowUp, bottom heading just opened, offset 12021, rect x=334.87 top=31.67 bottom=56.67 width=0 height=25, scrollY 4123
vim on, ArrowUp, bottom heading just opened, offset 12021, rect x=334.87 top=31.67 bottom=56.67, scrollY 4123
```
