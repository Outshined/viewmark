title: visual selection fencepost error
state: pending review
type: bug
priority: medium
parent:
depends:
reporter: Operator
created: 2026-10-21T01:30:26.542Z

when selecting text in vim keys, the last character that is under the carat needs to be included in the selection.  Test by highlighting two words and adding a comment, or pressing d to delete.  It will miss the character directly under the caret.