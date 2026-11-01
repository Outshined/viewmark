title: in vim keys '.' does not repeat a replace operation
state: pending review
type: bug
priority: medium
parent:
depends:
reporter: Operator
created: 2026-11-01T12:55:01.652Z

in vim keys mode pressing r to replace a single character, then that character should be repeated when . is pressed.  If there was a count, that needs to be part of the repeated command: pressing 10rx should replace the next 10 characters with x.  Pressing . will replace 10 characters starting with the current one under the caret with x.

This should work for all commands the same way.  Please consult obsidian and vim for beavior semantics.

Checked on 2026-11-01. r then a character, then . replaces the character under the caret. 10rx replaces ten characters with x, and . does that again from the caret. A count typed before . replaces the stored count. A digit given to r, f, F, t, or T stays the character of that command, so . still has it.
