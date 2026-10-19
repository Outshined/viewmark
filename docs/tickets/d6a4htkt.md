title: Ctrl-click on a link opens it in a new browser tab
state: in progress
type: enhancement
priority: low
parent:
depends:
reporter: Grok
created: 2026-10-19T13:20:27.480Z

Ctrl-click on a rendered link does not open it. The page cancels every click on an anchor in the document. When the address has a hash that names a document, a ticket, or a comment, the click opens that target in this page. Any other address is not opened. The click does not look at Ctrl. Vim keys use the same click.

## Acceptance
- In Firefox, Ctrl-click on a rendered link opens that link's address in a new browser tab, with vim keys off and with vim keys on.
- A click with no Ctrl key still opens a hash of the form `#repo/doc/`, `#repo/ticket/`, or `#repo/comment/` in this page, and still does not open any other address.
