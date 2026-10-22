title: Copy flyout is cut off the top of the page
state: closed
type: bug
priority: medium
parent:
depends:
reporter: Grok
created: 2026-10-22T14:44:38.352Z

The copy flyout is drawn above the control. The ticket id control sits at the top of the page, so the top of that flyout is off the page and only the bottom half shows. The same placement cuts off any copy flyout whose control is near the top edge.

Every copy flyout sits fully inside the visible page. It still prefers the space above the control. When that would leave the page, it sits below the control. When it would leave the left or right edge, it shifts inward until it is inside. The title stays the control name. The flyout does not take focus or move the caret.
