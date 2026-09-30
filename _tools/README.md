# Prerender (static HTML for crawlers)

The page is a Claude Design export: the text lives in the `<x-dc>` template with `{{ }}` placeholders, and `support.js` renders it with React in the browser. Without a prerender, bots and curl see raw placeholders.

`_tools/prerender.mjs` renders the page in headless Chrome and writes the result into `index.html`:

- `<div id="dc-prerender">` holds static HTML with real text, prices and final counter values. It is what bots and no-JS clients see.
- `<template id="dc-tpl">` holds the original `<x-dc>` template, byte for byte.
- A small inline shim runs during parsing. It removes the static copy, puts `<x-dc>` back and drops duplicate head tags, so the React runtime boots exactly as before. The page looks and behaves the same for visitors.

**After every edit of index.html, run:**

    node _tools/prerender.mjs          # or: npm run prerender

- The script is idempotent: it accepts a plain Claude Design export or an already prerendered file.
- `node _tools/prerender.mjs --restore` writes back the plain `<x-dc>` source, e.g. to edit or re-import into Claude Design.
- Needs Node 18+, `playwright-core` (`npm i`, or the casegen copy on this Mac) and Chrome (`CHROME_PATH=...` elsewhere).
