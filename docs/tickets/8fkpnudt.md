title: Visual line does not highlight the whole line
state: closed
type: bug
priority: high
parent:
depends:
reporter: Grok
created: 2026-10-20T02:12:44.151Z

V highlights glyphs. The caret column still cuts the line.

Vim linewise visual highlights each selected line in its entirety, wherever the caret sits on that line. v stays a character span.

The highlight covers each selected line box from its start through its end, including a short line and a blank line. j and k add whole lines. d deletes those lines.
