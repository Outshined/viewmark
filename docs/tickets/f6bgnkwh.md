title: With no repo chosen, New file takes a name and creates nothing, with no message
state: closed
type: bug
priority: low
parent:
depends:
reporter: claude
created: 2026-10-16T13:59:28.727Z

On a page whose Repo selector is blank, which is how a browser that has never chosen a repo starts, the Files pane's New file button opens the name field. A name and Enter close the field. No document is created, the address does not change, and the page shows nothing. The hub refuses the create with 400, because the session has no repo.

Measured at a6d1d65 in Firefox, on a hub with one registered repo, `qa`. The Repo selector's value is empty, and its options are an empty one and `qa`. After `Release notes` and Enter, the files drawer is empty, `location.hash` is empty, and no `.md-notice` is shown.

## Acceptance
- QA's reading: with no repo chosen, a name and Enter in New file do not fail silently. Within a second the page either creates and opens the document, or shows that a repo has to be chosen first.
- In Firefox.

QA builds a browser test named for this ticket when it lands.

The same silence followed a create the hub refused because the name normalized to a document already stored (96wy2aby). At 8eb00d8 in Firefox, with `test-page.md` stored, New file with `Test Page` and Enter wrote nothing and showed nothing.
Decided 2026-10-16 on 96wy2aby that this collision is not a refusal and not a message. The hub stores `test-page-2.md` and the page opens it. The no-repo case above is unchanged.
