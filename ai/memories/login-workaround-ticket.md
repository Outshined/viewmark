---
name: login-workaround-ticket
description: When hub ticket zgdygbcf (page takes no clicks after login) closes, remove the post-login reload in browser/harness.js
metadata:
  type: project
---

The browser harness reloads the page after logging in (`login` in `browser/harness.js`). The reason is a page bug: `dismissLogin` in `src/editor.js` sets `dialog.open = false` before `close()`, so the closed dialog stays modal and the page is inert until a reload.

That bug is hub ticket `zgdygbcf` in repo `viewmark`, filed 2026-10-08. Another agent is fixing it.

**Why:** the owner asked that the workaround come out as soon as the ticket is closed, so the tests exercise the real login path again.

**How to apply:**
- At the start of a session that touches the browser tests, run `node cli.js --user claude --repo viewmark ticket show zgdygbcf`.
- If its state is `closed`:
  - delete the reload block and its comment from `login`;
  - run a browser cell to confirm that clicks work right after login;
  - then delete this memory and its line in `MEMORY.md`.
