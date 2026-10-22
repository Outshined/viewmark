title: Click on a heading in a table cell lands on the hashes
state: pending review
type: bug
priority: medium
parent: vgx3hpze
depends:
reporter: Grok
created: 2026-10-22T16:16:42.030Z

A click on the drawn letter of a heading in a table cell lands on the first hash after the table opens. That hash was not drawn before the click. The word that was clicked draws about 24px to the right of the caret. Clicks on the list word, the quote word, and the code word in the same cells land on those words.

The walk used one document taller than the window, in Firefox, viewport 1920 by 1080, with vim keys off. The offsets below are from that walk.

The caret lands on the letter that was clicked. A Firefox test locks that.
```text
top cell heading, click x=313.75 y=677.12, offset 3539, rect x=318.53 top=678.07 bottom=696.07 width=0 height=18, word offset 3542 drawn left 342.08 top 678.07
middle cell heading, click x=313.75 y=636.88, offset 7824, rect x=318.53 top=637.83 bottom=655.83, word offset 7827 drawn left 342.08 top 637.83
bottom cell heading, click x=313.75 y=636.65, offset 12109, rect x=318.53 top=637.6 bottom=655.6, word offset 12112 drawn left 342.08 top 637.6
```
