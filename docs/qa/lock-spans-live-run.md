# Live run: lock spans and wrapped paragraphs

HEAD 86e3da175edbb5e4369a80b4d7367385f93b3606. Repository /home/paul/src/viewmark. Contract qa/lock-spans-test-plan.md.
Hub 127.0.0.1:46297 with a temp state directory. Port 8765 was not bound. The hub was stopped and the temp directories removed. ROM was not called. No play bot was started.
Spans and blocks come from lockSpans, lockIndexAt, and plan in src/doc.js. Locks and edit --find were driven on that hub.

PASS 1. FAIL 89. BLOCKED 0.

## 1. vacant document — FAIL

source ""

source length 0
spans: lockSpans("") = [{"start":0,"end":0}]; lockIndexAt(0) = 0
plan(doc, -1) blocks:
  nobar empty 0-0
expect: one vacant span with no inclusive index, and one empty block

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n001.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n001.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: empty string is [{"start":0,"end":0}], not a vacant span with no inclusive index

## 2. one newline — FAIL

source "\n"

source length 1
spans: 0-0 "\n"
plan(doc, -1) blocks:
  nobar empty 0-0
  nobar empty 1-1

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n002.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n002.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar empty 0-0
  nobar empty 1-1
expect:
  nobar empty 0-0

## 3. two newlines — FAIL

source "\n\n"

source length 2
spans: 0-0 "\n" | 1-1 "\n"
plan(doc, -1) blocks:
  nobar empty 0-0
  nobar empty 1-1
  nobar empty 2-2

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n003.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=1 cursor=1 rev=0
  <- {"type":"locks","path":"n003.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Bea"}]}
last locks {"type":"locks","path":"n003.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Bea"}]}
edit Ada rev=0 anchor=0 cursor=1 insert "X"
  <- {"type":"error","status":409}
  disk "\n\n"

wrong: blocks:
  nobar empty 0-0
  nobar empty 1-1
  nobar empty 2-2
expect:
  nobar empty 0-0
  nobar empty 1-1
wrong: edit Ada expected a write, got {"type":"error","status":409}
wrong: disk "\n\n" !== "X\n"
wrong: final disk "\n\n" !== "X\n"

## 4. soft paragraph — FAIL

source "Alpha\nBeta\n"

source length 11
spans: 0-10 "Alpha\nBeta\n"
plan(doc, -1) blocks:
  nobar md-p "Alpha"@0 SP@5 "Beta"@6 0-10
  nobar empty 11-11

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n004.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n004.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "Alpha"@0 SP@5 "Beta"@6 0-10
  nobar empty 11-11
expect:
  nobar md-p "Alpha"@0 SP@5 "Beta"@6 0-10

## 5. caret on the second source line — FAIL

source "Alpha\nBeta\n"

source length 11
spans: 0-10 "Alpha\nBeta\n"
plan(doc, -1) blocks:
  nobar md-p "Alpha"@0 SP@5 "Beta"@6 0-10
  nobar empty 11-11
plan(doc, 0):
  nobar md-p "Alpha"@0 SP@5 "Beta"@6 0-10
  nobar empty 11-11
plan(doc, 5):
  nobar md-p "Alpha"@0 SP@5 "Beta"@6 0-10
  nobar empty 11-11
plan(doc, 6):
  nobar md-p "Alpha"@0 SP@5 "Beta"@6 0-10
  nobar empty 11-11

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n005.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=6 cursor=6 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n005.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "Alpha"@0 SP@5 "Beta"@6 0-10
  nobar empty 11-11
expect:
  nobar md-p "Alpha"@0 SP@5 "Beta"@6 0-10
wrong: caret 0 shows 2 blocks, not one
wrong: caret 5 shows 2 blocks, not one
wrong: caret 6 shows 2 blocks, not one

## 6. no trailing newline — FAIL

source "Alpha\nBeta"

source length 10
spans: 0-10 "Alpha\nBeta"
plan(doc, -1) blocks:
  nobar md-p "Alpha"@0 SP@5 "Beta"@6 0-10

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n006.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=9 cursor=9 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n006.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: spans [[0,10]] !== [[0,9]]
wrong: blocks:
  nobar md-p "Alpha"@0 SP@5 "Beta"@6 0-10
expect:
  nobar md-p "Alpha"@0 SP@5 "Beta"@6 0-9

## 7. caret at end of file — FAIL

source "Alpha\nBeta\n"

source length 11
spans: 0-10 "Alpha\nBeta\n"
plan(doc, -1) blocks:
  nobar md-p "Alpha"@0 SP@5 "Beta"@6 0-10
  nobar empty 11-11
plan(doc, 11):
  nobar md-p "Alpha"@0 SP@5 "Beta"@6 0-10
  nobar empty 11-11
lockIndexAt(11)=0

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n007.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=11 cursor=11 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n007.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "Alpha"@0 SP@5 "Beta"@6 0-10
  nobar empty 11-11
expect:
  nobar md-p "Alpha"@0 SP@5 "Beta"@6 0-10

## 8. blank lines split paragraphs — FAIL

source "Alpha\n\n\nBeta\n"

source length 13
spans: 0-5 "Alpha\n" | 6-6 "\n" | 7-7 "\n" | 8-12 "Beta\n"
plan(doc, -1) blocks:
  nobar md-p "Alpha"@0 0-5
  nobar empty 6-6
  nobar empty 7-7
  nobar md-p "Beta"@8 8-12
  nobar empty 13-13

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n008.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=8 cursor=12 rev=0
  <- {"type":"locks","path":"n008.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":3,"username":"Bea"}]}
lock Cara anchor=6 cursor=6 rev=0
  <- {"type":"locks","path":"n008.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Cara"},{"index":3,"username":"Bea"}]}
edit Bea rev=0 anchor=session cursor=session insert "Gamma"
  <- {"type":"doc","rev":1,"text":"Alpha\n\n\nGamma\n"}
  disk "Alpha\n\n\nGamma\n"

wrong: blocks:
  nobar md-p "Alpha"@0 0-5
  nobar empty 6-6
  nobar empty 7-7
  nobar md-p "Beta"@8 8-12
  nobar empty 13-13
expect:
  nobar md-p "Alpha"@0 0-5
  nobar empty 6-6
  nobar empty 7-7
  nobar md-p "Beta"@8 8-12

## 9. a space-only line is not blank — FAIL

source "Alpha\n \nBeta\n"

source length 13
spans: 0-12 "Alpha\n \nBeta\n"
plan(doc, -1) blocks:
  nobar md-p "Alpha"@0 SP@5 " "@6 SP@7 "Beta"@8 0-12
  nobar empty 13-13

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n009.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=6 cursor=6 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n009.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "Alpha"@0 SP@5 " "@6 SP@7 "Beta"@8 0-12
  nobar empty 13-13
expect:
  nobar md-p "Alpha"@0 SP@5 " "@6 SP@7 "Beta"@8 0-12

## 10. heading ends a paragraph — FAIL

source "words\n# Title\nmore\n"

source length 19
spans: 0-5 "words\n" | 6-13 "# Title\n" | 14-18 "more\n"
plan(doc, -1) blocks:
  nobar md-p "words"@0 0-5
  nobar md-h1 "Title"@8 6-13
  nobar md-p "more"@14 14-18
  nobar empty 19-19

$ node cli.js --port 46297 --user Ed --repo docs edit n010.md --rev 0 --find "words\n#" --replace "nope"
  exit 153
  stdout "words\n# Title\nmore\n"
  stderr "rev 0\nconflict\n"
  disk "words\n# Title\nmore\n"
  watcher locks mentioning Ed: false [{"type":"locks","path":"n010.md","rev":0,"lines":[]}]
lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n010.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=14 cursor=18 rev=0
  <- {"type":"locks","path":"n010.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":2,"username":"Bea"}]}
edit Bea rev=0 anchor=session cursor=session insert "less"
  <- {"type":"doc","rev":1,"text":"words\n# Title\nless\n"}
  disk "words\n# Title\nless\n"

wrong: blocks:
  nobar md-p "words"@0 0-5
  nobar md-h1 "Title"@8 6-13
  nobar md-p "more"@14 14-18
  nobar empty 19-19
expect:
  nobar md-p "words"@0 0-5
  nobar md-h1 "Title"@8 6-13
  nobar md-p "more"@14 14-18

## 11. level-6 heading — FAIL

source "###### Title\n"

source length 13
spans: 0-12 "###### Title\n"
plan(doc, -1) blocks:
  nobar md-h6 "Title"@7 0-12
  nobar empty 13-13

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n011.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n011.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-h6 "Title"@7 0-12
  nobar empty 13-13
expect:
  nobar md-h6 "Title"@7 0-12

## 12. seven hashes are prose — FAIL

source "####### no\n"

source length 11
spans: 0-10 "####### no\n"
plan(doc, -1) blocks:
  nobar md-p "####### no"@0 0-10
  nobar empty 11-11

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n012.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n012.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "####### no"@0 0-10
  nobar empty 11-11
expect:
  nobar md-p "####### no"@0 0-10

## 13. heading requires the space — FAIL

source "words\n#Title\nmore\n"

source length 18
spans: 0-17 "words\n#Title\nmore\n"
plan(doc, -1) blocks:
  nobar md-p "words"@0 SP@5 "#Title"@6 SP@12 "more"@13 0-17
  nobar empty 18-18

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n013.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=6 cursor=6 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n013.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "words"@0 SP@5 "#Title"@6 SP@12 "more"@13 0-17
  nobar empty 18-18
expect:
  nobar md-p "words"@0 SP@5 "#Title"@6 SP@12 "more"@13 0-17

## 14. thematic break ends a paragraph — FAIL

source "words\n---\nmore\n"

source length 15
spans: 0-5 "words\n" | 6-9 "---\n" | 10-14 "more\n"
plan(doc, -1) blocks:
  nobar md-p "words"@0 0-5
  nobar hr 6-9
  nobar md-p "more"@10 10-14
  nobar empty 15-15

$ node cli.js --port 46297 --user Ed --repo docs edit n014.md --rev 0 --find "words\n---" --replace "nope"
  exit 153
  stdout "words\n---\nmore\n"
  stderr "rev 0\nconflict\n"
  disk "words\n---\nmore\n"
  watcher locks mentioning Ed: false [{"type":"locks","path":"n014.md","rev":0,"lines":[]}]
lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n014.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=10 cursor=10 rev=0
  <- {"type":"locks","path":"n014.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":2,"username":"Bea"}]}

wrong: blocks:
  nobar md-p "words"@0 0-5
  nobar hr 6-9
  nobar md-p "more"@10 10-14
  nobar empty 15-15
expect:
  nobar md-p "words"@0 0-5
  nobar hr 6-9
  nobar md-p "more"@10 10-14

## 15. the three rules — FAIL

source "***\n___\n---\n"

source length 12
spans: 0-3 "***\n" | 4-7 "___\n" | 8-11 "---\n"
plan(doc, -1) blocks:
  nobar hr 0-3
  nobar hr 4-7
  nobar hr 8-11
  nobar empty 12-12

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n015.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=4 cursor=4 rev=0
  <- {"type":"locks","path":"n015.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Bea"}]}

wrong: blocks:
  nobar hr 0-3
  nobar hr 4-7
  nobar hr 8-11
  nobar empty 12-12
expect:
  nobar hr 0-3
  nobar hr 4-7
  nobar hr 8-11

## 16. four dashes are prose — FAIL

source "words\n----\nmore\n"

source length 16
spans: 0-15 "words\n----\nmore\n"
plan(doc, -1) blocks:
  nobar md-p "words"@0 SP@5 "----"@6 SP@10 "more"@11 0-15
  nobar empty 16-16

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n016.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n016.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "words"@0 SP@5 "----"@6 SP@10 "more"@11 0-15
  nobar empty 16-16
expect:
  nobar md-p "words"@0 SP@5 "----"@6 SP@10 "more"@11 0-15

## 17. a padded rule is prose — FAIL

source "words\n ---\nmore\n"

source length 16
spans: 0-15 "words\n ---\nmore\n"
plan(doc, -1) blocks:
  nobar md-p "words"@0 SP@5 " ---"@6 SP@10 "more"@11 0-15
  nobar empty 16-16

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n017.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n017.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "words"@0 SP@5 " ---"@6 SP@10 "more"@11 0-15
  nobar empty 16-16
expect:
  nobar md-p "words"@0 SP@5 " ---"@6 SP@10 "more"@11 0-15

## 18. setext is prose — FAIL

source "words\n===\n"

source length 10
spans: 0-9 "words\n===\n"
plan(doc, -1) blocks:
  nobar md-p "words"@0 SP@5 "==="@6 0-9
  nobar empty 10-10

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n018.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n018.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "words"@0 SP@5 "==="@6 0-9
  nobar empty 10-10
expect:
  nobar md-p "words"@0 SP@5 "==="@6 0-9

## 19. zero trailing spaces, soft — FAIL

source "red\nblue\n"

source length 9
spans: 0-8 "red\nblue\n"
plan(doc, -1) blocks:
  nobar md-p "red"@0 SP@3 "blue"@4 0-8
  nobar empty 9-9

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n019.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=4 cursor=4 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n019.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "red"@0 SP@3 "blue"@4 0-8
  nobar empty 9-9
expect:
  nobar md-p "red"@0 SP@3 "blue"@4 0-8

## 20. one trailing space, still soft — FAIL

source "red \nblue\n"

source length 10
spans: 0-9 "red \nblue\n"
plan(doc, -1) blocks:
  nobar md-p "red "@0 SP@4 "blue"@5 0-9
  nobar empty 10-10

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n020.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n020.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "red "@0 SP@4 "blue"@5 0-9
  nobar empty 10-10
expect:
  nobar md-p "red "@0 SP@4 "blue"@5 0-9

## 21. two trailing spaces, hard break — FAIL

source "red  \nblue\n"

source length 11
spans: 0-10 "red  \nblue\n"
plan(doc, -1) blocks:
  nobar md-p "red"@0 BR@5 "blue"@6 0-10
  nobar empty 11-11

$ node cli.js --port 46297 --user Ed --repo docs edit n021.md --rev 0 --find "red  \nblue" --replace "red  \nBLUE"
  exit 0
  stdout "red  \nBLUE\n"
  stderr "rev 1\n"
  disk "red  \nBLUE\n"
  watcher locks mentioning Ed: true [{"type":"locks","path":"n021.md","rev":0,"lines":[{"index":0,"username":"Ed"}]},{"type":"locks","path":"n021.md","rev":1,"lines":[{"index":0,"username":"Ed"}]},{"type":"locks","path":"n021.md","rev":1,"lines":[]},{"type":"doc","path":"n021.md","rev":1,"text":"red  \nBLUE\n","from":6,"to":10,"inserted":"BLUE","actor":"Ed","cursor":10,"anchor":10}]
lock Ada anchor=0 cursor=0 rev=1
  <- {"type":"locks","path":"n021.md","rev":1,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=6 cursor=6 rev=1
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n021.md","rev":1,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "red"@0 BR@5 "blue"@6 0-10
  nobar empty 11-11
expect:
  nobar md-p "red"@0 BR@5 "blue"@6 0-10

## 22. three trailing spaces, hard break — FAIL

source "red   \nblue\n"

source length 12
spans: 0-11 "red   \nblue\n"
plan(doc, -1) blocks:
  nobar md-p "red"@0 BR@6 "blue"@7 0-11
  nobar empty 12-12

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n022.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n022.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "red"@0 BR@6 "blue"@7 0-11
  nobar empty 12-12
expect:
  nobar md-p "red"@0 BR@6 "blue"@7 0-11

## 23. trailing backslash, hard break — FAIL

source "red\\\nblue\n"

source length 10
spans: 0-9 "red\\\nblue\n"
plan(doc, -1) blocks:
  nobar md-p "red"@0 BR@4 "blue"@5 0-9
  nobar empty 10-10

$ node cli.js --port 46297 --user Ed --repo docs edit n023.md --rev 0 --find "red\\\nblue" --replace "red\\\nBLUE"
  exit 0
  stdout "red\\\nBLUE\n"
  stderr "rev 1\n"
  disk "red\\\nBLUE\n"
  watcher locks mentioning Ed: true [{"type":"locks","path":"n023.md","rev":0,"lines":[{"index":0,"username":"Ed"}]},{"type":"locks","path":"n023.md","rev":1,"lines":[{"index":0,"username":"Ed"}]},{"type":"locks","path":"n023.md","rev":1,"lines":[]},{"type":"doc","path":"n023.md","rev":1,"text":"red\\\nBLUE\n","from":5,"to":9,"inserted":"BLUE","actor":"Ed","cursor":9,"anchor":9}]

wrong: blocks:
  nobar md-p "red"@0 BR@4 "blue"@5 0-9
  nobar empty 10-10
expect:
  nobar md-p "red"@0 BR@4 "blue"@5 0-9

## 24. break grades — PASS

source length 9
spans: 0-8 "red\nblue\n"
plan(doc, -1) blocks:
  nobar md-p "red"@0 SP@3 "blue"@4 0-8
  nobar empty 9-9
grade displays (EOF phantom omitted from this comparison):
  19: nobar md-p "red"@0 SP@3 "blue"@4 0-8
  20: nobar md-p "red "@0 SP@4 "blue"@5 0-9
  21: nobar md-p "red"@0 BR@5 "blue"@6 0-10
  22: nobar md-p "red"@0 BR@6 "blue"@7 0-11
  23: nobar md-p "red"@0 BR@4 "blue"@5 0-9
sources equal? false

no hub socket: the five grades are compared in process and none is rewritten

## 25. a backslash that is not the last character — FAIL

source "red\\ \nblue\n"

source length 11
spans: 0-10 "red\\ \nblue\n"
plan(doc, -1) blocks:
  nobar md-p "red\\ "@0 SP@5 "blue"@6 0-10
  nobar empty 11-11

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n025.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n025.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "red\\ "@0 SP@5 "blue"@6 0-10
  nobar empty 11-11
expect:
  nobar md-p "red\ "@0 SP@5 "blue"@6 0-10

## 26. backslash at EOF — FAIL

source "red\\"

source length 4
spans: 0-4 "red\\"
plan(doc, -1) blocks:
  nobar md-p "red\\"@0 0-4

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n026.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n026.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: spans [[0,4]] !== [[0,3]]
wrong: blocks:
  nobar md-p "red\\"@0 0-4
expect:
  nobar md-p "red\"@0 0-3

## 27. two spaces at EOF — FAIL

source "red  "

source length 5
spans: 0-5 "red  "
plan(doc, -1) blocks:
  nobar md-p "red  "@0 0-5

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n027.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n027.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: spans [[0,5]] !== [[0,4]]
wrong: blocks:
  nobar md-p "red  "@0 0-5
expect:
  nobar md-p "red  "@0 0-4

## 28. hard break with nothing after it — FAIL

source "a  \n"

source length 4
spans: 0-3 "a  \n"
plan(doc, -1) blocks:
  nobar md-p "a"@0 BR@3 0-3
  nobar empty 4-4

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n028.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n028.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "a"@0 BR@3 0-3
  nobar empty 4-4
expect:
  nobar md-p "a"@0 BR@3 0-3

## 29. hard break then a soft newline — FAIL

source "red  \nblue\ngreen\n"

source length 17
spans: 0-16 "red  \nblue\ngreen\n"
plan(doc, -1) blocks:
  nobar md-p "red"@0 BR@5 "blue"@6 SP@10 "green"@11 0-16
  nobar empty 17-17

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n029.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=11 cursor=11 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n029.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "red"@0 BR@5 "blue"@6 SP@10 "green"@11 0-16
  nobar empty 17-17
expect:
  nobar md-p "red"@0 BR@5 "blue"@6 SP@10 "green"@11 0-16

## 30. a line of two spaces is a hard break, not a blank — FAIL

source "a  \n  \nb\n"

source length 9
spans: 0-8 "a  \n  \nb\n"
plan(doc, -1) blocks:
  nobar md-p "a"@0 BR@3 BR@6 "b"@7 0-8
  nobar empty 9-9

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n030.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n030.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "a"@0 BR@3 BR@6 "b"@7 0-8
  nobar empty 9-9
expect:
  nobar md-p "a"@0 BR@3 BR@6 "b"@7 0-8

## 31. quoted continuation — FAIL

source "> Alpha\nBeta\n"

source length 13
spans: 0-12 "> Alpha\nBeta\n"
plan(doc, -1) blocks:
  bar quote "Alpha"@2 SP@7 "Beta"@8 0-12
  nobar empty 13-13

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n031.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=8 cursor=8 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n031.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  bar quote "Alpha"@2 SP@7 "Beta"@8 0-12
  nobar empty 13-13
expect:
  bar quote "Alpha"@2 SP@7 "Beta"@8 0-12

## 32. a bare `>` continues the quote as prose — FAIL

source "> Alpha\n>\n"

source length 10
spans: 0-9 "> Alpha\n>\n"
plan(doc, -1) blocks:
  bar quote "Alpha"@2 SP@7 ">"@8 0-9
  nobar empty 10-10

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n032.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n032.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  bar quote "Alpha"@2 SP@7 ">"@8 0-9
  nobar empty 10-10
expect:
  bar quote "Alpha"@2 SP@7 ">"@8 0-9

## 33. `>` without a space is not a quote — FAIL

source ">\n"

source length 2
spans: 0-1 ">\n"
plan(doc, -1) blocks:
  nobar md-p ">"@0 0-1
  nobar empty 2-2

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n033.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n033.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p ">"@0 0-1
  nobar empty 2-2
expect:
  nobar md-p ">"@0 0-1

## 34. `>>` is not a quote — FAIL

source ">> Alpha\n"

source length 9
spans: 0-8 ">> Alpha\n"
plan(doc, -1) blocks:
  nobar md-p ">> Alpha"@0 0-8
  nobar empty 9-9

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n034.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n034.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p ">> Alpha"@0 0-8
  nobar empty 9-9
expect:
  nobar md-p ">> Alpha"@0 0-8

## 35. empty quote line — FAIL

source "> \n"

source length 3
spans: 0-2 "> \n"
plan(doc, -1) blocks:
  bar quote (empty prose) 0-2
  nobar empty 3-3

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n035.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n035.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  bar quote (empty prose) 0-2
  nobar empty 3-3
expect:
  bar quote (empty prose) 0-2

## 36. quoted blocks share a bar — FAIL

source "> Alpha\n\n> Beta\n"

source length 16
spans: 0-7 "> Alpha\n" | 8-8 "\n" | 9-15 "> Beta\n"
plan(doc, -1) blocks:
  bar quote "Alpha"@2 0-7
  nobar empty 8-8
  bar quote "Beta"@11 9-15
  nobar empty 16-16

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n036.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Cara anchor=8 cursor=8 rev=0
  <- {"type":"locks","path":"n036.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Cara"}]}
lock Bea anchor=11 cursor=15 rev=0
  <- {"type":"locks","path":"n036.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Cara"},{"index":2,"username":"Bea"}]}
edit Bea rev=0 anchor=session cursor=session insert "Gamma"
  <- {"type":"doc","rev":1,"text":"> Alpha\n\n> Gamma\n"}
  disk "> Alpha\n\n> Gamma\n"

wrong: blocks:
  bar quote "Alpha"@2 0-7
  nobar empty 8-8
  bar quote "Beta"@11 9-15
  nobar empty 16-16
expect:
  bar quote "Alpha"@2 0-7
  bar empty 8-8
  bar quote "Beta"@11 9-15

## 37. two blanks between quotes — FAIL

source "> a\n\n\n> b\n"

source length 10
spans: 0-3 "> a\n" | 4-4 "\n" | 5-5 "\n" | 6-9 "> b\n"
plan(doc, -1) blocks:
  bar quote "a"@2 0-3
  nobar empty 4-4
  nobar empty 5-5
  bar quote "b"@8 6-9
  nobar empty 10-10

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n037.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Cara anchor=4 cursor=4 rev=0
  <- {"type":"locks","path":"n037.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Cara"}]}
lock Bea anchor=8 cursor=8 rev=0
  <- {"type":"locks","path":"n037.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Cara"},{"index":3,"username":"Bea"}]}

wrong: blocks:
  bar quote "a"@2 0-3
  nobar empty 4-4
  nobar empty 5-5
  bar quote "b"@8 6-9
  nobar empty 10-10
expect:
  bar quote "a"@2 0-3
  bar empty 4-4
  bar empty 5-5
  bar quote "b"@8 6-9

## 38. a heading ends the quote — FAIL

source "> Alpha\n# Title\n"

source length 16
spans: 0-7 "> Alpha\n" | 8-15 "# Title\n"
plan(doc, -1) blocks:
  bar quote "Alpha"@2 0-7
  nobar md-h1 "Title"@10 8-15
  nobar empty 16-16

$ node cli.js --port 46297 --user Ed --repo docs edit n038.md --rev 0 --find "Alpha\n#" --replace "nope"
  exit 153
  stdout "> Alpha\n# Title\n"
  stderr "rev 0\nconflict\n"
  disk "> Alpha\n# Title\n"
  watcher locks mentioning Ed: false [{"type":"locks","path":"n038.md","rev":0,"lines":[]}]
lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n038.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=8 cursor=8 rev=0
  <- {"type":"locks","path":"n038.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Bea"}]}

wrong: blocks:
  bar quote "Alpha"@2 0-7
  nobar md-h1 "Title"@10 8-15
  nobar empty 16-16
expect:
  bar quote "Alpha"@2 0-7
  nobar md-h1 "Title"@10 8-15

## 39. a rule ends the quote — FAIL

source "> a\n---\n"

source length 8
spans: 0-3 "> a\n" | 4-7 "---\n"
plan(doc, -1) blocks:
  bar quote "a"@2 0-3
  nobar hr 4-7
  nobar empty 8-8

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n039.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=4 cursor=4 rev=0
  <- {"type":"locks","path":"n039.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Bea"}]}

wrong: blocks:
  bar quote "a"@2 0-3
  nobar hr 4-7
  nobar empty 8-8
expect:
  bar quote "a"@2 0-3
  nobar hr 4-7

## 40. a plain paragraph after a blank leaves the quote — FAIL

source "> a\n\nplain\n"

source length 11
spans: 0-3 "> a\n" | 4-4 "\n" | 5-10 "plain\n"
plan(doc, -1) blocks:
  bar quote "a"@2 0-3
  nobar empty 4-4
  nobar md-p "plain"@5 5-10
  nobar empty 11-11

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n040.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=5 cursor=10 rev=0
  <- {"type":"locks","path":"n040.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":2,"username":"Bea"}]}
edit Bea rev=0 anchor=session cursor=session insert "other"
  <- {"type":"doc","rev":1,"text":"> a\n\nother\n"}
  disk "> a\n\nother\n"

wrong: blocks:
  bar quote "a"@2 0-3
  nobar empty 4-4
  nobar md-p "plain"@5 5-10
  nobar empty 11-11
expect:
  bar quote "a"@2 0-3
  nobar empty 4-4
  nobar md-p "plain"@5 5-10

## 41. a top-level item after a blank leaves the quote — FAIL

source "> a\n\n- b\n"

source length 9
spans: 0-3 "> a\n" | 4-4 "\n" | 5-8 "- b\n"
plan(doc, -1) blocks:
  bar quote "a"@2 0-3
  nobar empty 4-4
  nobar md-li "b"@7 5-8
  nobar empty 9-9

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n041.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=5 cursor=5 rev=0
  <- {"type":"locks","path":"n041.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":2,"username":"Bea"}]}

wrong: blocks:
  bar quote "a"@2 0-3
  nobar empty 4-4
  nobar md-li "b"@7 5-8
  nobar empty 9-9
expect:
  bar quote "a"@2 0-3
  nobar empty 4-4
  nobar md-li "b"@7 5-8

## 42. a fence ends the quote — FAIL

source "> Alpha\n```js\nx\n```\n"

source length 20
spans: 0-7 "> Alpha\n" | 8-19 "```js\nx\n```\n"
plan(doc, -1) blocks:
  bar quote "Alpha"@2 0-7
  nobar md-codeblock "x"@14 8-19
  nobar empty 20-20

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n042.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=8 cursor=8 rev=0
  <- {"type":"locks","path":"n042.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Bea"}]}

wrong: blocks:
  bar quote "Alpha"@2 0-7
  nobar md-codeblock "x"@14 8-19
  nobar empty 20-20
expect:
  bar quote "Alpha"@2 0-7
  nobar md-codeblock "x"@14 8-19

## 43. quoted bullet — FAIL

source "> - Alpha\nBeta\n"

source length 15
spans: 0-14 "> - Alpha\nBeta\n"
plan(doc, -1) blocks:
  bar quote+md-li "Alpha"@4 SP@9 "Beta"@10 0-14
  nobar empty 15-15

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n043.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=10 cursor=10 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n043.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  bar quote+md-li "Alpha"@4 SP@9 "Beta"@10 0-14
  nobar empty 15-15
expect:
  bar quote+md-li "Alpha"@4 SP@9 "Beta"@10 0-14

## 44. quoted ordered item — FAIL

source "> 1. Alpha\nBeta\n"

source length 16
spans: 0-15 "> 1. Alpha\nBeta\n"
plan(doc, -1) blocks:
  bar quote+md-ol marker="1. " "Alpha"@5 SP@10 "Beta"@11 0-15
  nobar empty 16-16

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n044.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=11 cursor=11 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n044.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  bar quote+md-ol marker="1. " "Alpha"@5 SP@10 "Beta"@11 0-15
  nobar empty 16-16
expect:
  bar quote+md-ol marker="1." "Alpha"@5 SP@10 "Beta"@11 0-15

## 45. `> -Alpha` is not an item — FAIL

source "> -Alpha\n"

source length 9
spans: 0-8 "> -Alpha\n"
plan(doc, -1) blocks:
  bar quote "-Alpha"@2 0-8
  nobar empty 9-9

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n045.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n045.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  bar quote "-Alpha"@2 0-8
  nobar empty 9-9
expect:
  bar quote "-Alpha"@2 0-8

## 46. an indented marker after `>` is not a child item — FAIL

source ">   - child\n"

source length 12
spans: 0-11 ">   - child\n"
plan(doc, -1) blocks:
  bar quote "  - child"@2 0-11
  nobar empty 12-12

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n046.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n046.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  bar quote "  - child"@2 0-11
  nobar empty 12-12
expect:
  bar quote "  - child"@2 0-11

## 47. quoted item, child, and a following line — FAIL

source "> - Alpha\n  - Beta\nGamma\n"

source length 25
spans: 0-9 "> - Alpha\n" | 10-24 "  - Beta\nGamma\n"
plan(doc, -1) blocks:
  bar quote+md-li "Alpha"@4 0-9
  nobar md-li ind=2 "Beta"@14 SP@18 "Gamma"@19 10-24
  nobar empty 25-25

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n047.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=19 cursor=24 rev=0
  <- {"type":"locks","path":"n047.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Bea"}]}
edit Bea rev=0 anchor=session cursor=session insert "Delta"
  <- {"type":"doc","rev":1,"text":"> - Alpha\n  - Beta\nDelta\n"}
  disk "> - Alpha\n  - Beta\nDelta\n"

wrong: blocks:
  bar quote+md-li "Alpha"@4 0-9
  nobar md-li ind=2 "Beta"@14 SP@18 "Gamma"@19 10-24
  nobar empty 25-25
expect:
  bar quote+md-li "Alpha"@4 0-9
  bar quote+md-li ind=2 "Beta"@14 SP@18 "Gamma"@19 10-24

## 48. an equal item without `>` ends the quoted item and the quote — FAIL

source "> - Alpha\n- Beta\n"

source length 17
spans: 0-9 "> - Alpha\n" | 10-16 "- Beta\n"
plan(doc, -1) blocks:
  bar quote+md-li "Alpha"@4 0-9
  nobar md-li "Beta"@12 10-16
  nobar empty 17-17

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n048.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=10 cursor=10 rev=0
  <- {"type":"locks","path":"n048.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Bea"}]}

wrong: blocks:
  bar quote+md-li "Alpha"@4 0-9
  nobar md-li "Beta"@12 10-16
  nobar empty 17-17
expect:
  bar quote+md-li "Alpha"@4 0-9
  nobar md-li "Beta"@12 10-16

## 49. list continuation until the next item — FAIL

source "- Alpha\nBeta\n- Gamma\n"

source length 21
spans: 0-12 "- Alpha\nBeta\n" | 13-20 "- Gamma\n"
plan(doc, -1) blocks:
  nobar md-li "Alpha"@2 SP@7 "Beta"@8 0-12
  nobar md-li "Gamma"@15 13-20
  nobar empty 21-21

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n049.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=8 cursor=8 rev=0
  <- {"type":"error","status":409}
lock Cara anchor=13 cursor=20 rev=0
  <- {"type":"locks","path":"n049.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Cara"}]}
edit Cara rev=0 anchor=session cursor=session insert "- Delta"
  <- {"type":"doc","rev":1,"text":"- Alpha\nBeta\n- Delta\n"}
  disk "- Alpha\nBeta\n- Delta\n"

wrong: blocks:
  nobar md-li "Alpha"@2 SP@7 "Beta"@8 0-12
  nobar md-li "Gamma"@15 13-20
  nobar empty 21-21
expect:
  nobar md-li "Alpha"@2 SP@7 "Beta"@8 0-12
  nobar md-li "Gamma"@15 13-20

## 50. a blank ends a list item — FAIL

source "- Alpha\n\nBeta\n"

source length 14
spans: 0-7 "- Alpha\n" | 8-8 "\n" | 9-13 "Beta\n"
plan(doc, -1) blocks:
  nobar md-li "Alpha"@2 0-7
  nobar empty 8-8
  nobar md-p "Beta"@9 9-13
  nobar empty 14-14

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n050.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=9 cursor=13 rev=0
  <- {"type":"locks","path":"n050.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":2,"username":"Bea"}]}
edit Bea rev=0 anchor=session cursor=session insert "Gamma"
  <- {"type":"doc","rev":1,"text":"- Alpha\n\nGamma\n"}
  disk "- Alpha\n\nGamma\n"

wrong: blocks:
  nobar md-li "Alpha"@2 0-7
  nobar empty 8-8
  nobar md-p "Beta"@9 9-13
  nobar empty 14-14
expect:
  nobar md-li "Alpha"@2 0-7
  nobar empty 8-8
  nobar md-p "Beta"@9 9-13

## 51. a heading ends a list item — FAIL

source "- Alpha\n# H\n"

source length 12
spans: 0-7 "- Alpha\n" | 8-11 "# H\n"
plan(doc, -1) blocks:
  nobar md-li "Alpha"@2 0-7
  nobar md-h1 "H"@10 8-11
  nobar empty 12-12

$ node cli.js --port 46297 --user Ed --repo docs edit n051.md --rev 0 --find "Alpha\n#" --replace "nope"
  exit 153
  stdout "- Alpha\n# H\n"
  stderr "rev 0\nconflict\n"
  disk "- Alpha\n# H\n"
  watcher locks mentioning Ed: false [{"type":"locks","path":"n051.md","rev":0,"lines":[]}]
lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n051.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=8 cursor=8 rev=0
  <- {"type":"locks","path":"n051.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Bea"}]}

wrong: blocks:
  nobar md-li "Alpha"@2 0-7
  nobar md-h1 "H"@10 8-11
  nobar empty 12-12
expect:
  nobar md-li "Alpha"@2 0-7
  nobar md-h1 "H"@10 8-11

## 52. a rule ends a list item — FAIL

source "- Alpha\n---\nBeta\n"

source length 17
spans: 0-7 "- Alpha\n" | 8-11 "---\n" | 12-16 "Beta\n"
plan(doc, -1) blocks:
  nobar md-li "Alpha"@2 0-7
  nobar hr 8-11
  nobar md-p "Beta"@12 12-16
  nobar empty 17-17

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n052.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=12 cursor=12 rev=0
  <- {"type":"locks","path":"n052.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":2,"username":"Bea"}]}

wrong: blocks:
  nobar md-li "Alpha"@2 0-7
  nobar hr 8-11
  nobar md-p "Beta"@12 12-16
  nobar empty 17-17
expect:
  nobar md-li "Alpha"@2 0-7
  nobar hr 8-11
  nobar md-p "Beta"@12 12-16

## 53. a fence ends a list item — FAIL

source "- Alpha\n```js\nx\n```\n"

source length 20
spans: 0-7 "- Alpha\n" | 8-19 "```js\nx\n```\n"
plan(doc, -1) blocks:
  nobar md-li "Alpha"@2 0-7
  nobar md-codeblock "x"@14 8-19
  nobar empty 20-20

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n053.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=8 cursor=8 rev=0
  <- {"type":"locks","path":"n053.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Bea"}]}

wrong: blocks:
  nobar md-li "Alpha"@2 0-7
  nobar md-codeblock "x"@14 8-19
  nobar empty 20-20
expect:
  nobar md-li "Alpha"@2 0-7
  nobar md-codeblock "x"@14 8-19

## 54. a table ends a list item — FAIL

source "- Alpha\n| a |\n| --- |\n| 1 |\n"

source length 28
spans: 0-7 "- Alpha\n" | 8-21 "| a |\n| --- |\n" | 22-27 "| 1 |\n"
plan(doc, -1) blocks:
  nobar md-li "Alpha"@2 0-7
  table 8-27 H=["a"] R=[["1"]]
  nobar empty 28-28

$ node cli.js --port 46297 --user Ed --repo docs edit n054.md --rev 0 --find "| --- |\n| 1 |" --replace "nope"
  exit 153
  stdout "- Alpha\n| a |\n| --- |\n| 1 |\n"
  stderr "rev 0\nconflict\n"
  disk "- Alpha\n| a |\n| --- |\n| 1 |\n"
  watcher locks mentioning Ed: false [{"type":"locks","path":"n054.md","rev":0,"lines":[]}]
$ node cli.js --port 46297 --user Ed --repo docs edit n054.md --rev 0 --find "| a |\n| --- |" --replace "| z |\n| --- |"
  exit 0
  stdout "- Alpha\n| z |\n| --- |\n| 1 |\n"
  stderr "rev 1\n"
  disk "- Alpha\n| z |\n| --- |\n| 1 |\n"
  watcher locks mentioning Ed: true [{"type":"locks","path":"n054.md","rev":0,"lines":[{"index":1,"username":"Ed"}]},{"type":"locks","path":"n054.md","rev":1,"lines":[{"index":1,"username":"Ed"}]},{"type":"locks","path":"n054.md","rev":1,"lines":[]},{"type":"doc","path":"n054.md","rev":1,"text":"- Alpha\n| z |\n| --- |\n| 1 |\n","from":10,"to":11,"inserted":"z","actor":"Ed","cursor":21,"anchor":21}]
lock Ada anchor=0 cursor=0 rev=1
  <- {"type":"locks","path":"n054.md","rev":1,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=22 cursor=22 rev=1
  <- {"type":"locks","path":"n054.md","rev":1,"lines":[{"index":0,"username":"Ada"},{"index":2,"username":"Bea"}]}
lock Cara anchor=8 cursor=8 rev=1
  <- {"type":"locks","path":"n054.md","rev":1,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Cara"},{"index":2,"username":"Bea"}]}

wrong: blocks:
  nobar md-li "Alpha"@2 0-7
  table 8-27 H=["a"] R=[["1"]]
  nobar empty 28-28
expect:
  nobar md-li "Alpha"@2 0-7
  table 8-27 H=["a"] R=[["1"]]

## 55. parent, continuation, child, and a line after the child — FAIL

source "- Alpha\n  continues\n  - Beta\n  after\n- Gamma\n"

source length 45
spans: 0-19 "- Alpha\n  continues\n" | 20-36 "  - Beta\n  after\n" | 37-44 "- Gamma\n"
plan(doc, -1) blocks:
  nobar md-li "Alpha"@2 SP@7 "  continues"@8 0-19
  nobar md-li ind=2 "Beta"@24 SP@28 "  after"@29 20-36
  nobar md-li "Gamma"@39 37-44
  nobar empty 45-45

$ node cli.js --port 46297 --user Ed --repo docs edit n055.md --rev 0 --find "continues\n  - Beta" --replace "nope"
  exit 153
  stdout "- Alpha\n  continues\n  - Beta\n  after\n- Gamma\n"
  stderr "rev 0\nconflict\n"
  disk "- Alpha\n  continues\n  - Beta\n  after\n- Gamma\n"
  watcher locks mentioning Ed: false [{"type":"locks","path":"n055.md","rev":0,"lines":[]}]
lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n055.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=31 cursor=36 rev=0
  <- {"type":"locks","path":"n055.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Bea"}]}
edit Bea rev=0 anchor=session cursor=session insert "later"
  <- {"type":"doc","rev":1,"text":"- Alpha\n  continues\n  - Beta\n  later\n- Gamma\n"}
  disk "- Alpha\n  continues\n  - Beta\n  later\n- Gamma\n"

wrong: blocks:
  nobar md-li "Alpha"@2 SP@7 "  continues"@8 0-19
  nobar md-li ind=2 "Beta"@24 SP@28 "  after"@29 20-36
  nobar md-li "Gamma"@39 37-44
  nobar empty 45-45
expect:
  nobar md-li "Alpha"@2 SP@7 "  continues"@8 0-19
  nobar md-li ind=2 "Beta"@24 SP@28 "  after"@29 20-36
  nobar md-li "Gamma"@39 37-44

## 56. equal and lesser indents — FAIL

source "- a\n  - b\n    - c\n  - d\n- e\n"

source length 28
spans: 0-3 "- a\n" | 4-9 "  - b\n" | 10-17 "    - c\n" | 18-23 "  - d\n" | 24-27 "- e\n"
plan(doc, -1) blocks:
  nobar md-li "a"@2 0-3
  nobar md-li ind=2 "b"@8 4-9
  nobar md-li ind=4 "c"@16 10-17
  nobar md-li ind=2 "d"@22 18-23
  nobar md-li "e"@26 24-27
  nobar empty 28-28

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n056.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=18 cursor=18 rev=0
  <- {"type":"locks","path":"n056.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":3,"username":"Bea"}]}
lock Cara anchor=24 cursor=24 rev=0
  <- {"type":"locks","path":"n056.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":3,"username":"Bea"},{"index":4,"username":"Cara"}]}

wrong: blocks:
  nobar md-li "a"@2 0-3
  nobar md-li ind=2 "b"@8 4-9
  nobar md-li ind=4 "c"@16 10-17
  nobar md-li ind=2 "d"@22 18-23
  nobar md-li "e"@26 24-27
  nobar empty 28-28
expect:
  nobar md-li "a"@2 0-3
  nobar md-li ind=2 "b"@8 4-9
  nobar md-li ind=4 "c"@16 10-17
  nobar md-li ind=2 "d"@22 18-23
  nobar md-li "e"@26 24-27

## 57. a tab item and a four-space item are the same indent — FAIL

source "- a\n\t- b\n    - c\n"

source length 17
spans: 0-3 "- a\n" | 4-8 "\t- b\n" | 9-16 "    - c\n"
plan(doc, -1) blocks:
  nobar md-li "a"@2 0-3
  nobar md-li ind=4 "b"@7 4-8
  nobar md-li ind=4 "c"@15 9-16
  nobar empty 17-17

lock Ada anchor=4 cursor=4 rev=0
  <- {"type":"locks","path":"n057.md","rev":0,"lines":[{"index":1,"username":"Ada"}]}
lock Bea anchor=9 cursor=9 rev=0
  <- {"type":"locks","path":"n057.md","rev":0,"lines":[{"index":1,"username":"Ada"},{"index":2,"username":"Bea"}]}

wrong: blocks:
  nobar md-li "a"@2 0-3
  nobar md-li ind=4 "b"@7 4-8
  nobar md-li ind=4 "c"@15 9-16
  nobar empty 17-17
expect:
  nobar md-li "a"@2 0-3
  nobar md-li ind=4 "b"@7 4-8
  nobar md-li ind=4 "c"@15 9-16

## 58. ordered continuation and a parenthesis marker — FAIL

source "1. Alpha\n2 next\n1) Beta\n"

source length 24
spans: 0-15 "1. Alpha\n2 next\n" | 16-23 "1) Beta\n"
plan(doc, -1) blocks:
  nobar md-ol marker="1. " "Alpha"@3 SP@8 "2 next"@9 0-15
  nobar md-ol marker="1) " "Beta"@19 16-23
  nobar empty 24-24

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n058.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=9 cursor=9 rev=0
  <- {"type":"error","status":409}
lock Cara anchor=16 cursor=16 rev=0
  <- {"type":"locks","path":"n058.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Cara"}]}

wrong: blocks:
  nobar md-ol marker="1. " "Alpha"@3 SP@8 "2 next"@9 0-15
  nobar md-ol marker="1) " "Beta"@19 16-23
  nobar empty 24-24
expect:
  nobar md-ol marker="1." "Alpha"@3 SP@8 "2 next"@9 0-15
  nobar md-ol marker="1)" "Beta"@19 16-23

## 59. ten digits are not an ordered item — FAIL

source "1234567890. no\n"

source length 15
spans: 0-14 "1234567890. no\n"
plan(doc, -1) blocks:
  nobar md-p "1234567890. no"@0 0-14
  nobar empty 15-15

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n059.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n059.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "1234567890. no"@0 0-14
  nobar empty 15-15
expect:
  nobar md-p "1234567890. no"@0 0-14

## 60. a dash without a separator is prose — FAIL

source "-Alpha\nstill\n"

source length 13
spans: 0-12 "-Alpha\nstill\n"
plan(doc, -1) blocks:
  nobar md-p "-Alpha"@0 SP@6 "still"@7 0-12
  nobar empty 13-13

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n060.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n060.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "-Alpha"@0 SP@6 "still"@7 0-12
  nobar empty 13-13
expect:
  nobar md-p "-Alpha"@0 SP@6 "still"@7 0-12

## 61. `+` and `*` markers — FAIL

source + "+ Alpha\nBeta\n"

source length 13
spans: 0-12 "+ Alpha\nBeta\n"
plan(doc, -1) blocks:
  nobar md-li "Alpha"@2 SP@7 "Beta"@8 0-12
  nobar empty 13-13

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n061.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=8 cursor=8 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n061.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

source * "* Alpha\nBeta\n"

source length 13
spans: 0-12 "* Alpha\nBeta\n"
plan(doc, -1) blocks:
  nobar md-li "Alpha"@2 SP@7 "Beta"@8 0-12
  nobar empty 13-13

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n061b.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=8 cursor=8 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n061b.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: 61: blocks:
  nobar md-li "Alpha"@2 SP@7 "Beta"@8 0-12
  nobar empty 13-13
expect:
  nobar md-li "Alpha"@2 SP@7 "Beta"@8 0-12
wrong: 61b: blocks:
  nobar md-li "Alpha"@2 SP@7 "Beta"@8 0-12
  nobar empty 13-13
expect:
  nobar md-li "Alpha"@2 SP@7 "Beta"@8 0-12

## 62. empty item — FAIL

source "- \n"

source length 3
spans: 0-2 "- \n"
plan(doc, -1) blocks:
  nobar md-li (empty prose) 0-2
  nobar empty 3-3

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n062.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n062.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-li (empty prose) 0-2
  nobar empty 3-3
expect:
  nobar md-li (empty prose) 0-2

## 63. hard break inside an item — FAIL

source "- alpha  \nbeta\n"

source length 15
spans: 0-14 "- alpha  \nbeta\n"
plan(doc, -1) blocks:
  nobar md-li "alpha"@2 BR@9 "beta"@10 0-14
  nobar empty 15-15

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n063.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=10 cursor=10 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n063.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-li "alpha"@2 BR@9 "beta"@10 0-14
  nobar empty 15-15
expect:
  nobar md-li "alpha"@2 BR@9 "beta"@10 0-14

## 64. code fence — FAIL

source "```js\nlet x\n```\n"

source length 16
spans: 0-15 "```js\nlet x\n```\n"
plan(doc, -1) blocks:
  nobar md-codeblock "let x"@6 0-15
  nobar empty 16-16

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n064.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n064.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-codeblock "let x"@6 0-15
  nobar empty 16-16
expect:
  nobar md-codeblock "let x"@6 0-15

## 65. caret inside a fence — FAIL

source "```js\nlet x\n```\n"

source length 16
spans: 0-15 "```js\nlet x\n```\n"
plan(doc, -1) blocks:
  nobar md-codeblock "let x"@6 0-15
  nobar empty 16-16
plan(doc, 10) caret on x:
  nobar md-codeblock "```js"@0 BR@5 "let x"@6 BR@11 "```"@12 0-15
  nobar empty 16-16

lock Ada anchor=10 cursor=10 rev=0
  <- {"type":"locks","path":"n065.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=12 cursor=12 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n065.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-codeblock "let x"@6 0-15
  nobar empty 16-16
expect:
  nobar md-codeblock "let x"@6 0-15

## 66. unclosed code fence — FAIL

source "```js\nlet x"

source length 11
spans: 0-11 "```js\nlet x"
plan(doc, -1) blocks:
  nobar md-codeblock "let x"@6 0-11

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n066.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n066.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: spans [[0,11]] !== [[0,10]]
wrong: blocks:
  nobar md-codeblock "let x"@6 0-11
expect:
  nobar md-codeblock "let x"@6 0-10

## 67. fence with an empty info string — FAIL

source "```\ncode\n```\n"

source length 13
spans: 0-12 "```\ncode\n```\n"
plan(doc, -1) blocks:
  nobar md-codeblock "code"@4 0-12
  nobar empty 13-13

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n067.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n067.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-codeblock "code"@4 0-12
  nobar empty 13-13
expect:
  nobar md-codeblock "code"@4 0-12

## 68. mermaid fence — FAIL

source "```mermaid\ngraph TD\nA-->B\n```\n"

source length 30
spans: 0-29 "```mermaid\ngraph TD\nA-->B\n```\n"
plan(doc, -1) blocks:
  diagram 0-29 body="graph TD\nA-->B"
  nobar empty 30-30

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n068.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n068.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  diagram 0-29 body="graph TD\nA-->B"
  nobar empty 30-30
expect:
  diagram 0-29 body="graph TD\nA-->B"

## 69. `Mermaid` is code — FAIL

source "```Mermaid\ngraph TD\n```\n"

source length 24
spans: 0-23 "```Mermaid\ngraph TD\n```\n"
plan(doc, -1) blocks:
  nobar md-codeblock "graph TD"@11 0-23
  nobar empty 24-24

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n069.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n069.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-codeblock "graph TD"@11 0-23
  nobar empty 24-24
expect:
  nobar md-codeblock "graph TD"@11 0-23

## 70. a fence between paragraphs — FAIL

source "words\n```js\nx\n```\nmore\n"

source length 23
spans: 0-5 "words\n" | 6-17 "```js\nx\n```\n" | 18-22 "more\n"
plan(doc, -1) blocks:
  nobar md-p "words"@0 0-5
  nobar md-codeblock "x"@12 6-17
  nobar md-p "more"@18 18-22
  nobar empty 23-23

$ node cli.js --port 46297 --user Ed --repo docs edit n070.md --rev 0 --find "words\n```" --replace "nope"
  exit 153
  stdout "words\n```js\nx\n```\nmore\n"
  stderr "rev 0\nconflict\n"
  disk "words\n```js\nx\n```\nmore\n"
  watcher locks mentioning Ed: false [{"type":"locks","path":"n070.md","rev":0,"lines":[]}]
lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n070.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=6 cursor=6 rev=0
  <- {"type":"locks","path":"n070.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Bea"}]}
lock Cara anchor=18 cursor=22 rev=0
  <- {"type":"locks","path":"n070.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Bea"},{"index":2,"username":"Cara"}]}
edit Cara rev=0 anchor=session cursor=session insert "less"
  <- {"type":"doc","rev":1,"text":"words\n```js\nx\n```\nless\n"}
  disk "words\n```js\nx\n```\nless\n"

wrong: blocks:
  nobar md-p "words"@0 0-5
  nobar md-codeblock "x"@12 6-17
  nobar md-p "more"@18 18-22
  nobar empty 23-23
expect:
  nobar md-p "words"@0 0-5
  nobar md-codeblock "x"@12 6-17
  nobar md-p "more"@18 18-22

## 71. comment fence — FAIL

source "```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nThis note is the start of the thread.\n:: 1\n@2026-10-05T16:05:00.000Z Bea\nA reply keeps its own author line.\n```\n"

source length 161
spans: 0-13 "```comment c1\n" | 14-86 ":: 0\n@2026-10-05T16:00:00.000Z Ada\nThis note is the start of the thread.\n" | 87-156 ":: 1\n@2026-10-05T16:05:00.000Z Bea\nA reply keeps its own author line.\n" | 157-160 "```\n"
plan(doc, -1) blocks:
  nobar empty 161-161
comment expect: opener block 0-13; note block 14-86 contains 'This note is the start of the thread.' and not 'A reply keeps its own author line.'; note block 87-156 contains 'A reply keeps its own author line.'; closer block 157-160

lock Ada anchor=14 cursor=14 rev=0
  <- {"type":"locks","path":"n071.md","rev":0,"lines":[{"index":1,"username":"Ada"}]}
lock Bea anchor=122 cursor=156 rev=0
  <- {"type":"locks","path":"n071.md","rev":0,"lines":[{"index":1,"username":"Ada"},{"index":2,"username":"Bea"}]}
edit Bea rev=0 anchor=session cursor=session insert "A reply keeps its own edited line."
  <- {"type":"error","status":409}
  disk "```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nThis note is the start of the thread.\n:: 1\n@2026-10-05T16:05:00.000Z Bea\nA reply keeps its own author line.\n```\n"

wrong: comment display is 1 block(s), not opener, two notes, and closer:
  nobar empty 161-161
wrong: first note block does not contain only the first note text
wrong: second note text is not in its own block
wrong: edit Bea expected a write, got {"type":"error","status":409}
wrong: disk "```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nThis note is the start of the thread.\n:: 1\n@2026-10-05T16:05:00.000Z Bea\nA reply keeps its own author line.\n```\n" !== "```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nThis note is the start of the thread.\n:: 1\n@2026-10-05T16:05:00.000Z Bea\nA reply keeps its own edited line.\n```\n"
wrong: final disk "```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nThis note is the start of the thread.\n:: 1\n@2026-10-05T16:05:00.000Z Bea\nA reply keeps its own author line.\n```\n" !== "```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nThis note is the start of the thread.\n:: 1\n@2026-10-05T16:05:00.000Z Bea\nA reply keeps its own edited line.\n```\n"

## 72. find across comment notes — FAIL

source "```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nThis note is the start of the thread.\n:: 1\n@2026-10-05T16:05:00.000Z Bea\nA reply keeps its own author line.\n```\n"

source length 161
spans: 0-13 "```comment c1\n" | 14-86 ":: 0\n@2026-10-05T16:00:00.000Z Ada\nThis note is the start of the thread.\n" | 87-156 ":: 1\n@2026-10-05T16:05:00.000Z Bea\nA reply keeps its own author line.\n" | 157-160 "```\n"
plan(doc, -1) blocks:
  nobar empty 161-161
comment expect: opener block 0-13; note block 14-86 contains 'This note is the start of the thread.' and not 'A reply keeps its own author line.'; note block 87-156 contains 'A reply keeps its own author line.'; closer block 157-160

$ node cli.js --port 46297 --user Ed --repo docs edit n072.md --rev 0 --find "thread.\n:: 1" --replace "thread."
  exit 153
  stdout "```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nThis note is the start of the thread.\n:: 1\n@2026-10-05T16:05:00.000Z Bea\nA reply keeps its own author line.\n```\n"
  stderr "rev 0\nconflict\n"
  disk "```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nThis note is the start of the thread.\n:: 1\n@2026-10-05T16:05:00.000Z Bea\nA reply keeps its own author line.\n```\n"
  watcher locks mentioning Ed: false [{"type":"locks","path":"n072.md","rev":0,"lines":[]}]

wrong: comment display is 1 block(s), not opener, two notes, and closer:
  nobar empty 161-161
wrong: first note block does not contain only the first note text
wrong: second note text is not in its own block

## 73. a bare `::` starts a note — FAIL

source "```comment c1\n:: 0\nfirst\n::\nsecond\n```\n"

source length 39
spans: 0-13 "```comment c1\n" | 14-24 ":: 0\nfirst\n" | 25-34 "::\nsecond\n" | 35-38 "```\n"
plan(doc, -1) blocks:
  nobar empty 39-39
comment expect: opener; note contains first not second; note contains second; closer

lock Ada anchor=19 cursor=19 rev=0
  <- {"type":"locks","path":"n073.md","rev":0,"lines":[{"index":1,"username":"Ada"}]}
lock Bea anchor=28 cursor=34 rev=0
  <- {"type":"locks","path":"n073.md","rev":0,"lines":[{"index":1,"username":"Ada"},{"index":2,"username":"Bea"}]}
edit Bea rev=0 anchor=session cursor=session insert "SECOND"
  <- {"type":"error","status":409}
  disk "```comment c1\n:: 0\nfirst\n::\nsecond\n```\n"

wrong: note text is not in plan() blocks: ["nobar empty 39-39"]
wrong: first note does not contain first and exclude second
wrong: second note does not contain second
wrong: edit Bea expected a write, got {"type":"error","status":409}
wrong: disk "```comment c1\n:: 0\nfirst\n::\nsecond\n```\n" !== "```comment c1\n:: 0\nfirst\n::\nSECOND\n```\n"
wrong: final disk "```comment c1\n:: 0\nfirst\n::\nsecond\n```\n" !== "```comment c1\n:: 0\nfirst\n::\nSECOND\n```\n"

## 74. `:: 01` and `:: 1 ` do not split — FAIL

source "```comment c1\n:: 0\nsee\n:: 01\n:: 1 \nend\n```\n"

source length 43
spans: 0-13 "```comment c1\n" | 14-38 ":: 0\nsee\n:: 01\n:: 1 \nend\n" | 39-42 "```\n"
plan(doc, -1) blocks:
  nobar empty 43-43
comment expect: one note block containing ':: 01' and ':: 1 ' as text; closer

lock Ada anchor=14 cursor=14 rev=0
  <- {"type":"locks","path":"n074.md","rev":0,"lines":[{"index":1,"username":"Ada"}]}
lock Bea anchor=23 cursor=23 rev=0
  <- {"type":"error","status":409}
lock Cara anchor=39 cursor=39 rev=0
  <- {"type":"locks","path":"n074.md","rev":0,"lines":[{"index":1,"username":"Ada"},{"index":2,"username":"Cara"}]}

wrong: note text is not in plan() blocks: ["nobar empty 43-43"]
wrong: :: 01 and :: 1  are not text inside one note block

## 75. duplicate note ids are still two spans — FAIL

source "```comment c1\n:: 1\none\n:: 1\ntwo\n```\n"

source length 36
spans: 0-13 "```comment c1\n" | 14-22 ":: 1\none\n" | 23-31 ":: 1\ntwo\n" | 32-35 "```\n"
plan(doc, -1) blocks:
  nobar empty 36-36
comment expect: note contains one not two; note contains two; closer

lock Ada anchor=19 cursor=19 rev=0
  <- {"type":"locks","path":"n075.md","rev":0,"lines":[{"index":1,"username":"Ada"}]}
lock Bea anchor=28 cursor=31 rev=0
  <- {"type":"locks","path":"n075.md","rev":0,"lines":[{"index":1,"username":"Ada"},{"index":2,"username":"Bea"}]}
edit Bea rev=0 anchor=session cursor=session insert "TWO"
  <- {"type":"error","status":409}
  disk "```comment c1\n:: 1\none\n:: 1\ntwo\n```\n"

wrong: note text is not in plan() blocks: ["nobar empty 36-36"]
wrong: duplicate ids did not produce two note blocks
wrong: edit Bea expected a write, got {"type":"error","status":409}
wrong: disk "```comment c1\n:: 1\none\n:: 1\ntwo\n```\n" !== "```comment c1\n:: 1\none\n:: 1\nTWO\n```\n"
wrong: final disk "```comment c1\n:: 1\none\n:: 1\ntwo\n```\n" !== "```comment c1\n:: 1\none\n:: 1\nTWO\n```\n"

## 76. comment with no notes — FAIL

source "```comment c1\n```\n"

source length 18
spans: 0-13 "```comment c1\n" | 14-17 "```\n"
plan(doc, -1) blocks:
  nobar empty 18-18
comment expect: opener block; closer block; no note block between

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n076.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=14 cursor=14 rev=0
  <- {"type":"locks","path":"n076.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Bea"}]}

wrong: comment with no notes rendered ["nobar empty 18-18"], not opener and closer

## 77. unclosed comment — FAIL

source "```comment c1\n:: 0\nnote"

source length 23
spans: 0-13 "```comment c1\n" | 14-23 ":: 0\nnote"
plan(doc, -1) blocks:
comment expect: note block containing 'note'; no closer block

lock Ada anchor=14 cursor=14 rev=0
  <- {"type":"locks","path":"n077.md","rev":0,"lines":[{"index":1,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n077.md","rev":0,"lines":[{"index":0,"username":"Bea"},{"index":1,"username":"Ada"}]}

wrong: spans [[0,13],[14,23]] !== [[0,13],[14,22]]
wrong: no note block in plan(): []

## 78. table rows — FAIL

source "| Mark | Drawn |\n| --- | --- |\n| Bold | yes |\n| Em | no |\n"

source length 58
spans: 0-30 "| Mark | Drawn |\n| --- | --- |\n" | 31-45 "| Bold | yes |\n" | 46-57 "| Em | no |\n"
plan(doc, -1) blocks:
  table 0-57 H=["Mark","Drawn"] R=[["Bold","yes"],["Em","no"]]
  nobar empty 58-58

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n078.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=40 cursor=43 rev=0
  <- {"type":"locks","path":"n078.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Bea"}]}
lock Dora anchor=31 cursor=31 rev=0
  <- {"type":"error","status":409}
lock Cara anchor=46 cursor=46 rev=0
  <- {"type":"locks","path":"n078.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Bea"},{"index":2,"username":"Cara"}]}
edit Bea rev=0 anchor=session cursor=session insert "no"
  <- {"type":"doc","rev":1,"text":"| Mark | Drawn |\n| --- | --- |\n| Bold | no |\n| Em | no |\n"}
  disk "| Mark | Drawn |\n| --- | --- |\n| Bold | no |\n| Em | no |\n"

wrong: blocks:
  table 0-57 H=["Mark","Drawn"] R=[["Bold","yes"],["Em","no"]]
  nobar empty 58-58
expect:
  table 0-57 H=["Mark","Drawn"] R=[["Bold","yes"],["Em","no"]]

## 79. aligned delimiter stays in the header span — FAIL

source "| a | b |\n| :--- | ---: |\n| 1 | 2 |\n"

source length 36
spans: 0-25 "| a | b |\n| :--- | ---: |\n" | 26-35 "| 1 | 2 |\n"
plan(doc, -1) blocks:
  table 0-35 H=["a","b"] R=[["1","2"]]
  nobar empty 36-36

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n079.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=26 cursor=26 rev=0
  <- {"type":"locks","path":"n079.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":1,"username":"Bea"}]}

wrong: blocks:
  table 0-35 H=["a","b"] R=[["1","2"]]
  nobar empty 36-36
expect:
  table 0-35 H=["a","b"] R=[["1","2"]]

## 80. a pipe line without a delimiter is a paragraph — FAIL

source "| Mark | Drawn |\nnot a table\n"

source length 29
spans: 0-28 "| Mark | Drawn |\nnot a table\n"
plan(doc, -1) blocks:
  nobar md-p "| Mark | Drawn |"@0 SP@16 "not a table"@17 0-28
  nobar empty 29-29

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n080.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n080.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "| Mark | Drawn |"@0 SP@16 "not a table"@17 0-28
  nobar empty 29-29
expect:
  nobar md-p "| Mark | Drawn |"@0 SP@16 "not a table"@17 0-28

## 81. a blank ends a table — FAIL

source "| a |\n| --- |\n| 1 |\n\n| 2 |\n"

source length 27
spans: 0-13 "| a |\n| --- |\n" | 14-19 "| 1 |\n" | 20-20 "\n" | 21-26 "| 2 |\n"
plan(doc, -1) blocks:
  table 0-19 H=["a"] R=[["1"]]
  nobar empty 20-20
  nobar md-p "| 2 |"@21 21-26
  nobar empty 27-27

lock Ada anchor=14 cursor=14 rev=0
  <- {"type":"locks","path":"n081.md","rev":0,"lines":[{"index":1,"username":"Ada"}]}
lock Bea anchor=21 cursor=26 rev=0
  <- {"type":"locks","path":"n081.md","rev":0,"lines":[{"index":1,"username":"Ada"},{"index":3,"username":"Bea"}]}
edit Bea rev=0 anchor=session cursor=session insert "| 9 |"
  <- {"type":"doc","rev":1,"text":"| a |\n| --- |\n| 1 |\n\n| 9 |\n"}
  disk "| a |\n| --- |\n| 1 |\n\n| 9 |\n"

wrong: blocks:
  table 0-19 H=["a"] R=[["1"]]
  nobar empty 20-20
  nobar md-p "| 2 |"@21 21-26
  nobar empty 27-27
expect:
  table 0-19 H=["a"] R=[["1"]]
  nobar empty 20-20
  nobar md-p "| 2 |"@21 21-26

## 82. an image has no span — FAIL

source "See ![alt](u)\nhere.\n"

source length 20
spans: 0-19 "See ![alt](u)\nhere.\n"
plan(doc, -1) blocks:
  nobar md-p "See "@0 IMG(alt|u)@4-12 SP@13 "here."@14 0-19
  nobar empty 20-20

lock Ada anchor=4 cursor=4 rev=0
  <- {"type":"locks","path":"n082.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=14 cursor=14 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n082.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "See "@0 IMG(alt|u)@4-12 SP@13 "here."@14 0-19
  nobar empty 20-20
expect:
  nobar md-p "See "@0 IMG(alt|u)@4-12 SP@13 "here."@14 0-19

## 83. an image line is a paragraph span — FAIL

source "Before\n\n![alt](sample.svg)\n\nAfter\n"

source length 34
spans: 0-6 "Before\n" | 7-7 "\n" | 8-26 "![alt](sample.svg)\n" | 27-27 "\n" | 28-33 "After\n"
plan(doc, -1) blocks:
  nobar md-p "Before"@0 0-6
  nobar empty 7-7
  nobar md-p IMG(alt|sample.svg)@8-25 8-26
  nobar empty 27-27
  nobar md-p "After"@28 28-33
  nobar empty 34-34

lock Ada anchor=8 cursor=8 rev=0
  <- {"type":"locks","path":"n083.md","rev":0,"lines":[{"index":2,"username":"Ada"}]}
lock Bea anchor=28 cursor=33 rev=0
  <- {"type":"locks","path":"n083.md","rev":0,"lines":[{"index":2,"username":"Ada"},{"index":4,"username":"Bea"}]}
edit Bea rev=0 anchor=session cursor=session insert "Later"
  <- {"type":"doc","rev":1,"text":"Before\n\n![alt](sample.svg)\n\nLater\n"}
  disk "Before\n\n![alt](sample.svg)\n\nLater\n"

wrong: blocks:
  nobar md-p "Before"@0 0-6
  nobar empty 7-7
  nobar md-p IMG(alt|sample.svg)@8-25 8-26
  nobar empty 27-27
  nobar md-p "After"@28 28-33
  nobar empty 34-34
expect:
  nobar md-p "Before"@0 0-6
  nobar empty 7-7
  nobar md-p IMG(alt|sample.svg)@8-25 8-26
  nobar empty 27-27
  nobar md-p "After"@28 28-33

## 84. visual wrap does not change bytes — FAIL

source "The caret can travel to the end of this raw line while the pane wraps the text.\n"

source length 80
spans: 0-79 "The caret can travel to the end of this raw line while the pane wraps the text.\n"
plan(doc, -1) blocks:
  nobar md-p "The caret can travel to the end of this raw line while the pane wraps the text."@0 0-79
  nobar empty 80-80

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n084.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=0 cursor=0 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n084.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}

wrong: blocks:
  nobar md-p "The caret can travel to the end of this raw line while the pane wraps the text."@0 0-79
  nobar empty 80-80
expect:
  nobar md-p "The caret can travel to the end of this raw line while the pane wraps the text."@0 0-79

## 85. a find inside one paragraph may include its newline — FAIL

source "aa\nbb\n\ncc\ndd\n"

source length 13
spans: 0-5 "aa\nbb\n" | 6-6 "\n" | 7-12 "cc\ndd\n"
plan(doc, -1) blocks:
  nobar md-p "aa"@0 SP@2 "bb"@3 0-5
  nobar empty 6-6
  nobar md-p "cc"@7 SP@9 "dd"@10 7-12
  nobar empty 13-13

lock Bea anchor=7 cursor=7 rev=0
  <- {"type":"locks","path":"n085.md","rev":0,"lines":[{"index":2,"username":"Bea"}]}
$ node cli.js --port 46297 --user Ed --repo docs edit n085.md --rev 0 --find "aa\nbb" --replace "AA\nBB"
  exit 0
  stdout "AA\nBB\n\ncc\ndd\n"
  stderr "rev 1\n"
  disk "AA\nBB\n\ncc\ndd\n"
  watcher locks mentioning Ed: true [{"type":"locks","path":"n085.md","rev":0,"lines":[{"index":2,"username":"Bea"}]},{"type":"locks","path":"n085.md","rev":0,"lines":[{"index":0,"username":"Ed"},{"index":2,"username":"Bea"}]},{"type":"locks","path":"n085.md","rev":1,"lines":[{"index":0,"username":"Ed"},{"index":2,"username":"Bea"}]},{"type":"locks","path":"n085.md","rev":1,"lines":[{"index":2,"username":"Bea"}]},{"type":"doc","path":"n085.md","rev":1,"text":"AA\nBB\n\ncc\ndd\n","from":0,"to":5,"inserted":"AA\nBB","actor":"Ed","cursor":5,"anchor":5}]

wrong: blocks:
  nobar md-p "aa"@0 SP@2 "bb"@3 0-5
  nobar empty 6-6
  nobar md-p "cc"@7 SP@9 "dd"@10 7-12
  nobar empty 13-13
expect:
  nobar md-p "aa"@0 SP@2 "bb"@3 0-5
  nobar empty 6-6
  nobar md-p "cc"@7 SP@9 "dd"@10 7-12

## 86. a find across a blank returns 409 — FAIL

source "aa\nbb\n\ncc\ndd\n"

source length 13
spans: 0-5 "aa\nbb\n" | 6-6 "\n" | 7-12 "cc\ndd\n"
plan(doc, -1) blocks:
  nobar md-p "aa"@0 SP@2 "bb"@3 0-5
  nobar empty 6-6
  nobar md-p "cc"@7 SP@9 "dd"@10 7-12
  nobar empty 13-13

$ node cli.js --port 46297 --user Ed --repo docs edit n086.md --rev 0 --find "bb\n\ncc" --replace "nope"
  exit 153
  stdout "aa\nbb\n\ncc\ndd\n"
  stderr "rev 0\nconflict\n"
  disk "aa\nbb\n\ncc\ndd\n"
  watcher locks mentioning Ed: false [{"type":"locks","path":"n086.md","rev":0,"lines":[]}]

wrong: blocks:
  nobar md-p "aa"@0 SP@2 "bb"@3 0-5
  nobar empty 6-6
  nobar md-p "cc"@7 SP@9 "dd"@10 7-12
  nobar empty 13-13
expect:
  nobar md-p "aa"@0 SP@2 "bb"@3 0-5
  nobar empty 6-6
  nobar md-p "cc"@7 SP@9 "dd"@10 7-12

## 87. the two newlines at a paragraph boundary are not one span — FAIL

source "aa\nbb\n\ncc\ndd\n"

source length 13
spans: 0-5 "aa\nbb\n" | 6-6 "\n" | 7-12 "cc\ndd\n"
plan(doc, -1) blocks:
  nobar md-p "aa"@0 SP@2 "bb"@3 0-5
  nobar empty 6-6
  nobar md-p "cc"@7 SP@9 "dd"@10 7-12
  nobar empty 13-13

$ node cli.js --port 46297 --user Ed --repo docs edit n087.md --rev 0 --find "\n\n" --replace "nope"
  exit 153
  stdout "aa\nbb\n\ncc\ndd\n"
  stderr "rev 0\nconflict\n"
  disk "aa\nbb\n\ncc\ndd\n"
  watcher locks mentioning Ed: false [{"type":"locks","path":"n087.md","rev":0,"lines":[]}]

wrong: blocks:
  nobar md-p "aa"@0 SP@2 "bb"@3 0-5
  nobar empty 6-6
  nobar md-p "cc"@7 SP@9 "dd"@10 7-12
  nobar empty 13-13
expect:
  nobar md-p "aa"@0 SP@2 "bb"@3 0-5
  nobar empty 6-6
  nobar md-p "cc"@7 SP@9 "dd"@10 7-12

## 88. two editors write two spans — FAIL

source "aa\nbb\n\ncc\ndd\n"

source length 13
spans: 0-5 "aa\nbb\n" | 6-6 "\n" | 7-12 "cc\ndd\n"
plan(doc, -1) blocks:
  nobar md-p "aa"@0 SP@2 "bb"@3 0-5
  nobar empty 6-6
  nobar md-p "cc"@7 SP@9 "dd"@10 7-12
  nobar empty 13-13

lock Ada anchor=0 cursor=2 rev=0
  <- {"type":"locks","path":"n088.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=7 cursor=9 rev=0
  <- {"type":"locks","path":"n088.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":2,"username":"Bea"}]}
edit Ada rev=0 anchor=session cursor=session insert "AA"
  <- {"type":"doc","rev":1,"text":"AA\nbb\n\ncc\ndd\n"}
  disk "AA\nbb\n\ncc\ndd\n"
edit Bea rev=0 anchor=session cursor=session insert "CC"
  <- {"type":"error","status":409}
  disk "AA\nbb\n\ncc\ndd\n"

wrong: blocks:
  nobar md-p "aa"@0 SP@2 "bb"@3 0-5
  nobar empty 6-6
  nobar md-p "cc"@7 SP@9 "dd"@10 7-12
  nobar empty 13-13
expect:
  nobar md-p "aa"@0 SP@2 "bb"@3 0-5
  nobar empty 6-6
  nobar md-p "cc"@7 SP@9 "dd"@10 7-12
wrong: edit Bea expected a write, got {"type":"error","status":409}
wrong: disk "AA\nbb\n\ncc\ndd\n" !== "AA\nbb\n\nCC\ndd\n"
wrong: final disk "AA\nbb\n\ncc\ndd\n" !== "AA\nbb\n\nCC\ndd\n"

## 89. the second editor cannot take a held span — FAIL

source "aa\nbb\n\ncc\ndd\n"

source length 13
spans: 0-5 "aa\nbb\n" | 6-6 "\n" | 7-12 "cc\ndd\n"
plan(doc, -1) blocks:
  nobar md-p "aa"@0 SP@2 "bb"@3 0-5
  nobar empty 6-6
  nobar md-p "cc"@7 SP@9 "dd"@10 7-12
  nobar empty 13-13

lock Ada anchor=0 cursor=0 rev=0
  <- {"type":"locks","path":"n089.md","rev":0,"lines":[{"index":0,"username":"Ada"}]}
lock Bea anchor=7 cursor=7 rev=0
  <- {"type":"locks","path":"n089.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":2,"username":"Bea"}]}
lock Bea anchor=3 cursor=3 rev=0
  <- {"type":"error","status":409}
last locks {"type":"locks","path":"n089.md","rev":0,"lines":[{"index":0,"username":"Ada"},{"index":2,"username":"Bea"}]}

wrong: blocks:
  nobar md-p "aa"@0 SP@2 "bb"@3 0-5
  nobar empty 6-6
  nobar md-p "cc"@7 SP@9 "dd"@10 7-12
  nobar empty 13-13
expect:
  nobar md-p "aa"@0 SP@2 "bb"@3 0-5
  nobar empty 6-6
  nobar md-p "cc"@7 SP@9 "dd"@10 7-12

## 90. partition — FAIL

step 1 FAIL empty source is [{"start":0,"end":0}], not a vacant span; a span starts at length
  lockSpans("") = [{"start":0,"end":0}]; lockIndexAt(0) = 0
step 2 PASS 0-0 "\n"
step 3 PASS 0-0 "\n" | 1-1 "\n"
step 4 PASS 0-10 "Alpha\nBeta\n"
step 5 PASS 0-10 "Alpha\nBeta\n"
step 6 FAIL span 0-10 ends on or past length 10; coverage ends at 11, length 10
  0-10 "Alpha\nBeta"
step 7 PASS 0-10 "Alpha\nBeta\n"
step 8 PASS 0-5 "Alpha\n" | 6-6 "\n" | 7-7 "\n" | 8-12 "Beta\n"
step 9 PASS 0-12 "Alpha\n \nBeta\n"
step 10 PASS 0-5 "words\n" | 6-13 "# Title\n" | 14-18 "more\n"
step 11 PASS 0-12 "###### Title\n"
step 12 PASS 0-10 "####### no\n"
step 13 PASS 0-17 "words\n#Title\nmore\n"
step 14 PASS 0-5 "words\n" | 6-9 "---\n" | 10-14 "more\n"
step 15 PASS 0-3 "***\n" | 4-7 "___\n" | 8-11 "---\n"
step 16 PASS 0-15 "words\n----\nmore\n"
step 17 PASS 0-15 "words\n ---\nmore\n"
step 18 PASS 0-9 "words\n===\n"
step 19 PASS 0-8 "red\nblue\n"
step 20 PASS 0-9 "red \nblue\n"
step 21 PASS 0-10 "red  \nblue\n"
step 22 PASS 0-11 "red   \nblue\n"
step 23 PASS 0-9 "red\\\nblue\n"
step 25 PASS 0-10 "red\\ \nblue\n"
step 26 FAIL span 0-4 ends on or past length 4; coverage ends at 5, length 4
  0-4 "red\\"
step 27 FAIL span 0-5 ends on or past length 5; coverage ends at 6, length 5
  0-5 "red  "
step 28 PASS 0-3 "a  \n"
step 29 PASS 0-16 "red  \nblue\ngreen\n"
step 30 PASS 0-8 "a  \n  \nb\n"
step 31 PASS 0-12 "> Alpha\nBeta\n"
step 32 PASS 0-9 "> Alpha\n>\n"
step 33 PASS 0-1 ">\n"
step 34 PASS 0-8 ">> Alpha\n"
step 35 PASS 0-2 "> \n"
step 36 PASS 0-7 "> Alpha\n" | 8-8 "\n" | 9-15 "> Beta\n"
step 37 PASS 0-3 "> a\n" | 4-4 "\n" | 5-5 "\n" | 6-9 "> b\n"
step 38 PASS 0-7 "> Alpha\n" | 8-15 "# Title\n"
step 39 PASS 0-3 "> a\n" | 4-7 "---\n"
step 40 PASS 0-3 "> a\n" | 4-4 "\n" | 5-10 "plain\n"
step 41 PASS 0-3 "> a\n" | 4-4 "\n" | 5-8 "- b\n"
step 42 PASS 0-7 "> Alpha\n" | 8-19 "```js\nx\n```\n"
step 43 PASS 0-14 "> - Alpha\nBeta\n"
step 44 PASS 0-15 "> 1. Alpha\nBeta\n"
step 45 PASS 0-8 "> -Alpha\n"
step 46 PASS 0-11 ">   - child\n"
step 47 PASS 0-9 "> - Alpha\n" | 10-24 "  - Beta\nGamma\n"
step 48 PASS 0-9 "> - Alpha\n" | 10-16 "- Beta\n"
step 49 PASS 0-12 "- Alpha\nBeta\n" | 13-20 "- Gamma\n"
step 50 PASS 0-7 "- Alpha\n" | 8-8 "\n" | 9-13 "Beta\n"
step 51 PASS 0-7 "- Alpha\n" | 8-11 "# H\n"
step 52 PASS 0-7 "- Alpha\n" | 8-11 "---\n" | 12-16 "Beta\n"
step 53 PASS 0-7 "- Alpha\n" | 8-19 "```js\nx\n```\n"
step 54 PASS 0-7 "- Alpha\n" | 8-21 "| a |\n| --- |\n" | 22-27 "| 1 |\n"
step 55 PASS 0-19 "- Alpha\n  continues\n" | 20-36 "  - Beta\n  after\n" | 37-44 "- Gamma\n"
step 56 PASS 0-3 "- a\n" | 4-9 "  - b\n" | 10-17 "    - c\n" | 18-23 "  - d\n" | 24-27 "- e\n"
step 57 PASS 0-3 "- a\n" | 4-8 "\t- b\n" | 9-16 "    - c\n"
step 58 PASS 0-15 "1. Alpha\n2 next\n" | 16-23 "1) Beta\n"
step 59 PASS 0-14 "1234567890. no\n"
step 60 PASS 0-12 "-Alpha\nstill\n"
step 61 PASS 0-12 "+ Alpha\nBeta\n"
step 61b PASS 0-12 "* Alpha\nBeta\n"
step 62 PASS 0-2 "- \n"
step 63 PASS 0-14 "- alpha  \nbeta\n"
step 64 PASS 0-15 "```js\nlet x\n```\n"
step 65 PASS 0-15 "```js\nlet x\n```\n"
step 66 FAIL span 0-11 ends on or past length 11; coverage ends at 12, length 11
  0-11 "```js\nlet x"
step 67 PASS 0-12 "```\ncode\n```\n"
step 68 PASS 0-29 "```mermaid\ngraph TD\nA-->B\n```\n"
step 69 PASS 0-23 "```Mermaid\ngraph TD\n```\n"
step 70 PASS 0-5 "words\n" | 6-17 "```js\nx\n```\n" | 18-22 "more\n"
step 71 PASS 0-13 "```comment c1\n" | 14-86 ":: 0\n@2026-10-05T16:00:00.000Z Ada\nThis note is the start of the thread.\n" | 87-156 ":: 1\n@2026-10-05T16:05:00.000Z Bea\nA reply keeps its own author line.\n" | 157-160 "```\n"
step 72 PASS 0-13 "```comment c1\n" | 14-86 ":: 0\n@2026-10-05T16:00:00.000Z Ada\nThis note is the start of the thread.\n" | 87-156 ":: 1\n@2026-10-05T16:05:00.000Z Bea\nA reply keeps its own author line.\n" | 157-160 "```\n"
step 73 PASS 0-13 "```comment c1\n" | 14-24 ":: 0\nfirst\n" | 25-34 "::\nsecond\n" | 35-38 "```\n"
step 74 PASS 0-13 "```comment c1\n" | 14-38 ":: 0\nsee\n:: 01\n:: 1 \nend\n" | 39-42 "```\n"
step 75 PASS 0-13 "```comment c1\n" | 14-22 ":: 1\none\n" | 23-31 ":: 1\ntwo\n" | 32-35 "```\n"
step 76 PASS 0-13 "```comment c1\n" | 14-17 "```\n"
step 77 FAIL span 14-23 ends on or past length 23; coverage ends at 24, length 23
  0-13 "```comment c1\n" | 14-23 ":: 0\nnote"
step 78 PASS 0-30 "| Mark | Drawn |\n| --- | --- |\n" | 31-45 "| Bold | yes |\n" | 46-57 "| Em | no |\n"
step 79 PASS 0-25 "| a | b |\n| :--- | ---: |\n" | 26-35 "| 1 | 2 |\n"
step 80 PASS 0-28 "| Mark | Drawn |\nnot a table\n"
step 81 PASS 0-13 "| a |\n| --- |\n" | 14-19 "| 1 |\n" | 20-20 "\n" | 21-26 "| 2 |\n"
step 82 PASS 0-19 "See ![alt](u)\nhere.\n"
step 83 PASS 0-6 "Before\n" | 7-7 "\n" | 8-26 "![alt](sample.svg)\n" | 27-27 "\n" | 28-33 "After\n"
step 84 PASS 0-79 "The caret can travel to the end of this raw line while the pane wraps the text.\n"
step 85 PASS 0-5 "aa\nbb\n" | 6-6 "\n" | 7-12 "cc\ndd\n"
step 86 PASS 0-5 "aa\nbb\n" | 6-6 "\n" | 7-12 "cc\ndd\n"
step 87 PASS 0-5 "aa\nbb\n" | 6-6 "\n" | 7-12 "cc\ndd\n"
step 88 PASS 0-5 "aa\nbb\n" | 6-6 "\n" | 7-12 "cc\ndd\n"
step 89 PASS 0-5 "aa\nbb\n" | 6-6 "\n" | 7-12 "cc\ndd\n"

wrong: step 1: empty source is [{"start":0,"end":0}], not a vacant span; a span starts at length spans lockSpans("") = [{"start":0,"end":0}]; lockIndexAt(0) = 0
wrong: step 6: span 0-10 ends on or past length 10; coverage ends at 11, length 10 spans 0-10 "Alpha\nBeta"
wrong: step 26: span 0-4 ends on or past length 4; coverage ends at 5, length 4 spans 0-4 "red\\"
wrong: step 27: span 0-5 ends on or past length 5; coverage ends at 6, length 5 spans 0-5 "red  "
wrong: step 66: span 0-11 ends on or past length 11; coverage ends at 12, length 11 spans 0-11 "```js\nlet x"
wrong: step 77: span 14-23 ends on or past length 23; coverage ends at 24, length 23 spans 0-13 "```comment c1\n" | 14-23 ":: 0\nnote"

PASS 1. FAIL 89. BLOCKED 0.

First FAIL: step 1 vacant document
empty string is [{"start":0,"end":0}], not a vacant span with no inclusive index
