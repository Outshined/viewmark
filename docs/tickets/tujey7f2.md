title: Raw markdown toggle button misbehaving
state: pending review
type: bug
priority: medium
parent:
depends:
reporter: Operator
created: 2026-11-01T12:58:06.309Z

After clicking the 'view raw markdown' toggle to see the raw markdown, then toggling it back again every keystorke in the editor makes the button bounce.  It's adding weird latency to the input as a side effect.  This behavior follows between docs, and is cleared when the page is fully reloaded.    

Expectation is that the user should be able to toggle to/from raw markdown without the button on the page freaking out.

Checked on 2026-11-01. Toggling to raw markdown and back plays that button's press once. A later keystroke does not play it again, including after another document is opened.