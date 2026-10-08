# OpsPilot - notes for Claude Code

Read README.md for the full picture. This file holds the working rules and
the decisions behind the code, so a new session doesn't undo them.

## Working rules (from the project owner)

- **Work directly on `main`.** Don't create branches or pull requests unless asked.
- **`git pull` before starting any task**; the owner also edits on their laptop.
- **Run `npm test` before every push** (100+ checks, must all pass). Don't push red.
- After changing `src/styles/app.css` or any class names in `views/`, run
  `npm run build:css` and commit the rebuilt `public/css/app.css`.
- Never commit `.env` or `data/.embedding-cache.json` (both git-ignored).
- Be honest and direct with the owner; correct them when they're wrong.

## Commands

```
npm run dev          start with auto-reload (http://localhost:3000)
npm test             end-to-end smoke test (starts its own server, mock mode)
npm run evaluate     AI-vs-baseline evaluation -> docs/evaluation-results.md
npm run build:css    rebuild Tailwind CSS (watch:css while editing)
npm run seed         WIPES and re-seeds MongoDB (needs MONGODB_URI)
npm run make-admin -- <email>   promote an existing user to admin
TEST_MONGODB_URI=mongodb://localhost:27017/opspilot_test npm test   real-DB mode (wipes that DB)
```

## Architecture decisions

- `lib/store.js` is the ONLY place that branches on mock vs. MongoDB mode.
  The mode is decided once at startup and never changes. Mock reads return
  copies (like Mongo does).
- Embeddings: Gemini (`gemini-embedding-001`, 768 dims) when LLM_API_KEY is a
  Gemini key, OpenAI if it starts with `sk-`. The AI side never throws: no key
  gives "skipped", and an API failure gives "error"; ticket creation never breaks.
- Duplicate thresholds: AI 0.88 (Gemini), baseline Jaccard 0.10. Both are each
  method's best-F1 value on the seed set, so they were tuned the same way. Don't
  change them without re-running `npm run evaluate`. Admins can set LIVE
  thresholds on /admin/settings (lib/settings.js); the evaluation always uses
  the tuned ones (tunedAiThreshold) - keep it that way. Quote HELD-OUT numbers
  (AI F1 0.95 vs. baseline 0.67), never the tuned seed-set ones.
- Dashboard numbers are computed with the same filters as the lists they link to
  (`lib/ticketFilters.js`). Keep it that way; the test checks every link.
- SLA "at risk" is a rule (75% of target used), not a trained model. Don't call
  it prediction.
- Internal notes live in their own collection and are only loaded by routes
  that already checked the user is staff. Never embed them in the ticket.
- Confirm = merge NEWER into OLDER; the merged ticket's comments are copied
  to the primary as a staff-only internal note (requesters differ). The
  decision stats are precision only, never call them recall/accuracy.
- Roles: end_user, agent, manager (= service-desk manager), admin. Admin has
  every manager right (requireRole('manager') also admits admin; views use
  `managerRights`). Line managers and department heads are ORG LINKS, not
  roles. Role is re-read from the DB on every request (server.js).
- Users are referenced by EMAIL everywhere (managerEmail, headEmail,
  assigneeEmail), never by _id. Departments by `code` (e.g. "IT").
- Approvals (lib/approvals.js): only it moves tickets out of Pending
  Approval / Rejected. Skip rules are applied when a step is REACHED. A
  missing approver waits unassigned; never auto-skip approval.
- Schema changes need a step in store.migrate() (runs at startup,
  idempotent, fills in missing fields only) so older databases keep working.
- Help assistant is retrieval only (returns written KB articles, no generated
  text). End users never see other users' tickets or duplicate results.
- UI: Tailwind v4, compiled (not CDN). Semantic colour tokens + dark mode in
  `src/styles/app.css`. Classes built from data (`pill-<%= x %>`) must be listed
  in its `@source inline(...)` lines or they won't be generated.

## Still open

- Real MongoDB mode passes the full test suite (local MongoDB 8.3). The
  owner's DB is named `OpsPilot` (capital O and P); a lowercase name in
  MONGODB_URI fails on Windows and the app silently falls back to mock mode.
- Known gaps: no CSRF tokens, in-memory session store, no password reset.
- Built: internal notes, confirm/reject duplicates + merge (/admin/duplicate-stats),
  canned responses (/canned).
