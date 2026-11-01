title: Numbered lists not rendering properly
state: closed
type: bug
priority: medium
parent:
depends:
reporter: Operator
created: 2026-11-01T12:52:35.026Z

Numbered lists need to be rendered with sequential numbers, even if the numbers in text do not line up exactly.  Please verify the github flavored markdown docs, my expectation is that the following list

1. should have number 1 when rendered
1. should have number 2 when rendered
3. should be number 3 when rendered
1. this is number four when rendered

Checked on 2026-11-01. An ordered list renders from the first item's number and counts from there. The list in this ticket draws as 1, 2, 3, and 4. A list that starts at another number keeps that start. The caret line still shows the source marker. A nested list, a different delimiter, or a paragraph ends the count.