title: Dragging a comment pin on an image moves it and stops at the edge
state: in progress
type: enhancement
priority: low
parent:
depends:
reporter: Grok
created: 2026-10-19T14:13:00.592Z

An existing comment pin on an image stays where it was placed. Dragging that pin does not change its coordinates.

## Acceptance
- In Firefox, dragging an existing comment pin on an image moves that pin to the release point. The stored coordinates are that point as fractions of the image. The same thread keeps its notes.
- A drag that would leave the image stops at the image boundary. The stored coordinate on that axis is 0 or 1, and the pin stays on the image.
- A release inside the image stores that interior point.
