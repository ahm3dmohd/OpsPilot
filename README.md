# OpsPilot

A HelpDesk / ITSM ticketing system built as a Bahrain Polytechnic
Cooperative Learning Project (CLP) capstone. General-purpose IT helpdesk
(not tied to any specific company), with three real roles and an
AI-assisted duplicate-ticket detection feature that is evaluated against a
hand-written keyword baseline.

## Getting started

```bash
npm install
npm run dev        # or: npm start
```

Runs on `http://localhost:3000` with **no `.env` file required**. With no
`MONGODB_URI` set (or if the database it points to can't be reached within
5 seconds) the app runs in **mock-data mode**: users and tickets live in
memory and are re-seeded on every start.

**Demo logins** (password `password123` for all):

| Email | Role |
|---|---|
| `enduser@opspilot.test` | End User (owns T-1003, T-1012, T-1020) |
| `agent@opspilot.test` | Agent (Adel Haddad) |
| `agent2@opspilot.test` | Agent (Sara Ali) |
| `manager@opspilot.test` | Manager |

To turn on the AI features and/or real persistence, `cp .env.example .env`
and fill in what you need. Every setting is explained in `.env.example`.

| Command | What it does |
|---|---|
| `npm run dev` | Start with auto-reload (nodemon) |
| `npm run build:css` | Rebuild `public/css/app.css` from `src/styles/app.css` with Tailwind (the built file is committed, so only needed after changing styles or templates) |
| `npm run watch:css` | Rebuild the CSS automatically while you edit (run next to `npm run dev`) |
| `npm start` | Start normally |
| `npm run seed` | **Wipe** and load demo users + seed tickets into MongoDB (needs `MONGODB_URI`) |
| `npm test` | End-to-end smoke test: starts the server and checks the workflow, duplicate detection, notifications, knowledge base, CSV export and every role's 403s (100 checks) |
| `npm run evaluate` | AI-vs-baseline evaluation; writes `docs/evaluation-results.md` (also viewable in the app at `/evaluation`) |

## Look and feel

Styled with **Tailwind CSS v4**, compiled ahead of time with the Tailwind
CLI. The CDN build isn't used: it compiles styles in the browser on every
page load and Tailwind doesn't recommend it for production.

- **Design idea.** An IT operations desk. Ticket lists use the air-traffic
  "flight strip" format:
  - a coloured left edge for priority
  - the ticket ID set like a callsign
  - the time left on the SLA at the right

  Everything around the strips is kept plain.
- **Tokens.** Colours are semantic variables (`canvas`, `surface`, `ink`,
  `brand`, `caution`, `danger`...) defined in `src/styles/app.css`, so the
  **dark mode** toggle only swaps variables. The choice is remembered per
  browser and defaults to the system setting.
- **Type.** IBM Plex Sans for all text, with IBM Plex Mono only for ticket
  and article IDs. Both are served from `public/fonts` (no Google Fonts),
  so a demo works offline.
- **Icons.** [Lucide](https://lucide.dev) (ISC licence), inlined as SVG by
  `icon()` in `lib/viewHelpers.js`.
- **Layout.** A sidebar app shell (`views/partials/layout-top.ejs`) that
  collapses behind a menu button on phones. Press `/` to jump to search.
- **Accessibility.** Visible keyboard focus, a skip link, labelled
  controls, and reduced motion respected.

Classes built from data in templates (such as `pill-<%= priority %>`) are
listed with `@source inline(...)` in `src/styles/app.css`, because
Tailwind's scanner can't see them. `npm test` checks that they're present
in the compiled CSS.

## Mock mode vs. real database

`lib/store.js` is the **only** file that knows which mode is active. Every
route calls the same store functions either way, and they return plain
objects in both modes. The mode is decided once at startup:

- `MONGODB_URI` blank → mock mode.
- `MONGODB_URI` set and reachable → MongoDB mode. Run `npm run seed` once
  to load the demo data.
- `MONGODB_URI` set but unreachable → falls back to mock mode, and the
  console says so.

The mode never switches while the app is running. If the database drops
mid-session, requests show an error page rather than silently swapping to
demo data (mongoose command buffering is off, so they fail fast instead of
hanging).

## Roles and access

| | End User | Agent | Manager |
|---|---|---|---|
| Submit tickets | ✅ | ❌ 403 | ❌ 403 (by design) |
| See tickets | own only | all | all |
| Comment | own tickets | ✅ | ✅ |
| Claim | ❌ | ✅ (only if unassigned) | ❌ |
| Assign to an agent | ❌ | ❌ | ✅ |
| Change status | ❌ | ✅ | ✅ |
| See possible duplicates | ❌ (would leak others' tickets) | ✅ | ✅ |
| Confirm (merge) / reject a suggested duplicate | ❌ | ✅ | ✅ |
| Internal (staff-only) notes: read and write | ❌ never sent to them | ✅ | ✅ |
| Read / search / rate KB articles | ✅ | ✅ | ✅ |
| Write / edit KB articles | ❌ | ✅ | ✅ |
| Delete KB articles | ❌ | ❌ | ✅ |
| Notifications | own | own | own |
| Filtered ticket list (`/tickets`) | ❌ | ✅ | ✅ |
| CSV export, AI evaluation page, duplicate-decision stats, audit log | ❌ | ❌ | ✅ |

Real authentication: sessions (`express-session`) and bcrypt-hashed
passwords. The session ID is regenerated on login. Cookies are `httpOnly`
and `sameSite=lax`, plus `secure` in production. Public sign-up always
creates End User accounts. Set `ALLOW_ROLE_SELECT_ON_REGISTER=true` only
for demos.

**`SESSION_SECRET`** signs the session cookie. Treat it like a password:
anyone who has it can forge a login as any user, including a manager. Keep
it long and random, keep it only in `.env` (never commit or share it), and
rotate it if it leaks. The app refuses to start without it when
`NODE_ENV=production`.

## Ticket workflow

- Status: `Open` → `In Progress` → `Resolved` → `Closed`. Moves go forward
  one step at a time; a `Resolved` ticket can be re-opened to
  `In Progress`; `Closed` is final. Rules live in `lib/constants.js` and
  are enforced on the server, not just hidden in the UI.
- Priority: `Low` / `Medium` / `High` / `Urgent`.
- Every ticket keeps a comment thread and a status history with
  timestamps, shown together as one activity timeline.
- Claims are a single conditional update, so two agents clicking at once
  can't both get the ticket. Ticket IDs come from an atomic counter in
  MongoDB mode.

## Core AI feature: duplicate detection

Every new ticket is checked by **two independent methods**. Their results
are stored side by side on the ticket (`duplicates.ai` and
`duplicates.baseline`) and never merged, so they can be compared.

| | AI method | Baseline method |
|---|---|---|
| How | Embed title + description (`gemini-embedding-001` or OpenAI `text-embedding-3-small`), then cosine similarity against every other ticket's stored embedding | Hand-written: lowercase → strip punctuation → remove stopwords → light suffix-stripping → keyword set, then Jaccard similarity |
| Code | `lib/embeddings.js`, `lib/duplicates.js` | `lib/similarity.js`, `lib/duplicates.js` |
| Threshold | 0.88 (Gemini) | 0.10 |
| Keeps | top 5 above threshold | top 5 above threshold |

- **Who sees it:** agents and managers get a "Possible duplicates" panel on
  the ticket page and a `Dup? AI n · KW n` badge in the queue and ticket
  lists. End users never see it, because it reveals other people's
  tickets.
- **No API key:** the AI side records `skipped` and returns null instead of
  throwing. The baseline still runs and ticket creation is unaffected.
- **API errors:** a bad key, an outage or a timeout (10s limit) are
  recorded as `error` with the reason. Ticket creation still succeeds;
  this was tested with an invalid key.
- **Embedding cache:** embeddings are cached in
  `data/.embedding-cache.json` (git-ignored), so restarts and re-runs
  don't spend API quota twice.
- **Re-run check:** seed tickets are checked automatically at startup, and
  staff can re-run the check on any ticket with the "Re-run check" button.

**Why the thresholds differ from the spec's 0.82 / 0.25:** those numbers
fit OpenAI's model, not Gemini's. On the seed set, Gemini at 0.82 flagged
16 false pairs. Both thresholds are now each method's best-F1 value on the
seed set, so the two methods were tuned the same way.

### Agent decisions: confirm / reject + merge

Each suggestion on the ticket page has **Confirm & merge** and **Reject**
buttons (`lib/duplicateDecisions.js`). Every decision is stored in its own
collection (`DuplicateDecision`): the pair, which method(s) flagged it,
both scores and thresholds at the time, the decision, the agent and the
time. A pair can only be decided once.

- **Confirm** merges the **newer** ticket into the **older** one. The newer
  ticket is closed and points to the older one (`mergedInto`); nothing on
  it is deleted. The older ticket gets a staff-only internal note with a
  full copy of the newer ticket's description, comments and internal
  notes. They are copied as an internal note, not as comments, because the
  two requesters are usually different people. The newer ticket's
  requester is notified that it was closed as a duplicate, without the
  other ticket's ID.
- **Reject** records the decision and the pair is never suggested again
  (also after "Re-run check"). Merged tickets are never suggested again
  either.
- **`/admin/duplicate-stats`** (managers): total suggested pairs, waiting,
  confirmed, rejected and the confirmation rate, overall and per method
  (AI, baseline, both, AI only, baseline only), plus a one-row-per-decision
  CSV at `/admin/duplicate-stats.csv`.

The confirmation rate is the **precision** of each method in real use. It
can't measure recall: duplicates that no method suggested never reach an
agent.

### Evaluation (`npm run evaluate`, or `/evaluation` in the app)

`data/tickets.json` is a synthetic set of 20 generic IT tickets with no
real people or companies. It contains **deliberate near-duplicate
clusters**, each ticket labelled with its `cluster`:

- vpn ×4
- account lockout ×3
- printer offline ×2
- slow laptop ×2
- email sync ×2
- software license ×2
- standalone tickets ×5, including one hard negative: T-1019 "wifi keeps
  dropping" sounds like the VPN tickets but is a different problem

Because the right answer is known in advance, each method can be scored
with precision, recall and F1, not just eyeballed. That is the point of
the AI-vs-baseline section of the report.

`data/eval-holdout.json` holds 12 further tickets that were **never used
for tuning**: 8 paraphrases of the clusters in different wording, plus 4
unrelated tickets. Each is scored at the fixed thresholds. Latest results:

| | Seed set (tuned, so optimistic) | Held-out set (fair) |
|---|---|---|
| AI (Gemini) | P 100%, R 100%, F1 1.00 | P 100%, R 91%, F1 **0.95**; top match right 8/8; false alarms 0/4 |
| Baseline | P 71%, R 77%, F1 0.74 | P 86%, R 55%, F1 **0.67**; top match right 6/8; false alarms 1/4 |

The full tables, threshold sweeps and the hardest cases are in
`docs/evaluation-results.md`, and on the manager-only `/evaluation` page.
Both come from the same code (`lib/evaluation.js`), and both run on the
fixed data files rather than live tickets, so the numbers don't drift as
the app is used. Read its caveats before quoting these
numbers: the set is small, the AI threshold's margin on the seed set is
only about 0.02, and the held-out tickets were written by the same author
as the seed tickets.

## Stretch features: what's built

| # | Feature | Status | Notes |
|---|---|---|---|
| 1 | Auto-categorization & routing | **Built** | "Suggest category" on the new-ticket form: a k-nearest-neighbour vote (k=5) over existing tickets, using embeddings or keywords. The suggestion is pre-selected but editable, and whether the user kept it is stored for the report. Routing: staff see the lowest-workload agent as a suggested assignee, and managers can assign with one click. Tickets are **not** auto-assigned without a person choosing. |
| 2 | SLA breach prediction | **Built (rule-based)** | First-response and resolution targets per priority (`lib/sla.js`: Urgent 1h/4h, High 4h/24h, Medium 8h/72h, Low 24h/120h, wall-clock hours). A running clock that has used ≥75% of its target is flagged **at risk** before it breaches. Time in each status is tracked. The manager dashboard has an SLA watch list and the agent queue is sorted by urgency. This is a threshold rule, **not** a trained prediction model. |
| 3 | Self-service help assistant | **Built (retrieval only)** | A "Need help?" widget for end users, a `/help` page (works without JavaScript), and suggestions on the new-ticket form. It finds the closest knowledge-base articles (`data/kb.json`, 10 articles) and the user's **own** related open tickets. It returns written articles word for word and generates no text, so it can't invent wrong instructions. It is not a conversational chatbot. |

## Other features

- **Clickable dashboard numbers + filtered ticket list** (`/tickets`):
  - Every number on the manager dashboard links to the tickets behind it
    (statuses, SLA cards, categories, priorities, agent workload,
    duplicate-detection counts, category suggestions).
  - The list filters by status, active, priority, category, assignee, SLA
    state, duplicate result and category suggestion, plus free-text search
    and sorting. Filters show as removable chips and live in the URL, so a
    view can be bookmarked or shared.
  - The dashboard computes each number with the same filter code
    (`lib/ticketFilters.js`) as the list it opens, so a number always
    equals its list. `npm test` follows every dashboard link to check
    this.
  - "Export these as CSV" downloads just the filtered tickets.

- **In-app notifications** (`lib/notify.js`), shown as a count in the nav
  bar and on the `/notifications` page:
  - claimed → requester
  - assigned by a manager → requester + agent
  - status changed / comment → requester + assignee
  - new Urgent ticket → every agent
  - closed as a confirmed duplicate → that ticket's requester

  You're never notified about your own actions. A failed notification
  never undoes the action that triggered it.
- **Internal notes**: a yellow, lock-labelled panel on the ticket page for
  staff-only notes. They live in their own collection (`InternalNote`),
  not inside the ticket, and the ticket route only loads them for agents
  and managers, so the requester's page, notifications and the CSV export
  never contain them. Posting one is a 403 for end users. The audit log
  records that a note was added, not its text.
- **Knowledge base** (`/kb`): browse and keyword search for everyone.
  Agents and managers can write and edit articles; managers can delete
  them. Each article tracks **views** (counted once per session) and
  **"Was this helpful?" votes** (one per session). These are shown on
  articles and on the manager dashboard as real data on which self-service
  content works. The help assistant searches the same articles, so a new
  article is suggested straight away.
- **CSV export** (manager dashboard → Export CSV): one row per ticket with
  status, timestamps, hours to first response and to resolution, SLA
  states, both duplicate methods' matches and category-suggestion
  acceptance. It is built to be analysed in Excel. Fields that would start
  with `=`, `+`, `-` or `@` are prefixed with `'`, so a malicious ticket
  title can't run as a spreadsheet formula (CSV injection).

**Email notifications are not built.** They need an SMTP account and
credentials, and outbound mail couldn't be tested from the development
environment. Adding `nodemailer` behind an optional `SMTP_URL` inside
`lib/notify.js`'s `send()` would be the place to do it.

**Also added:** a hash-chained audit log (`/audit`, managers only) that
records logins, sign-ups, ticket creation, duplicate checks, claims,
assignments, status changes, comments, internal notes (not their text),
duplicate confirm/reject decisions, KB edits and CSV exports. Each entry's hash covers the
previous entry, and the page verifies the whole chain, so editing or
deleting history is detectable. It works in both modes, and a failed audit
write never blocks the user's action.

## Not built / known limitations

- **No CSRF tokens.** `sameSite=lax` cookies block the common cross-site
  form attack in modern browsers, but real CSRF tokens (e.g. `csurf`
  replacements) would be needed for production.
- **Sessions are kept in memory** (the express-session MemoryStore), so
  everyone is logged out on restart and it won't scale past one process.
  Production would use `connect-mongo`.
- **No password reset, account management or admin UI** for creating staff
  accounts. Staff come from the seed, or from the demo sign-up switch.
- **No email notifications, file attachments, ticket search or
  pagination.**
- **SLA clocks use wall-clock hours**, not business hours or holidays.
- **OpenAI support is coded but untested here**: `api.openai.com` is
  blocked in the development environment. Its threshold of 0.82 is
  uncalibrated; run `npm run evaluate` with an OpenAI key to tune it.
- **MongoDB mode was verified by code review and a simulated round-trip,
  not a live database**: MongoDB downloads are blocked in the development
  environment. Verify it yourself with
  `TEST_MONGODB_URI=mongodb://localhost:27017/opspilot_test npm test`.
  That command **wipes** the database you point it at.

## Project structure

```
server.js                entry point: sessions, DB-or-mock decision, routes, startup duplicate check
routes/
  auth.routes.js           login, register (End User only), logout
  dashboard.routes.js      role-based dashboards (end user / agent / manager)
  tickets.routes.js        create, suggest, view, claim, assign, status, comment, internal notes, re-run / confirm / reject duplicates
  admin.routes.js          audit log, AI evaluation page, CSV export, duplicate-decision stats, help assistant
  kb.routes.js             knowledge base: list/search, view, vote, create/edit/delete
  notifications.routes.js  notification list, open, mark all read
  (tickets.routes.js also serves the filtered list at GET /tickets)
middleware/auth.js       requireLogin / requireRole guards, asyncHandler
models/                  Mongoose schemas: User, Ticket, Article, Notification, Counter, AuditLog, InternalNote, DuplicateDecision
lib/
  store.js                 data access layer - the only mock-vs-DB branch
  constants.js             roles, statuses, priorities, categories, allowed status moves
  seedData.js              demo users + seed tickets, shared by mock mode and npm run seed
  embeddings.js            Gemini / OpenAI embeddings client with cache, timeout, never throws
  similarity.js            cosine, tokenizer, stemmer, Jaccard (hand-written)
  duplicates.js            the two duplicate-detection methods
  duplicateDecisions.js    confirm (merge) / reject a suggested pair, decision stats
  categorize.js            category suggestion + workload-based assignee
  sla.js                   SLA targets, at-risk rule, time in status
  assistant.js             help assistant retrieval
  evaluation.js            AI-vs-baseline scoring (shared by npm run evaluate and /evaluation)
  notify.js                who gets notified about what
  csv.js                   CSV writer with formula-injection guard
  ticketFilters.js         ticket filters shared by /tickets, CSV export and dashboard counts
  audit.js                 audit-log hash chain
  activity.js              logAction() used by routes
  viewHelpers.js           icon(), timeAgo(), duration(), slaClock() for templates
data/
  tickets.json             20 synthetic seed tickets with cluster labels
  eval-holdout.json        12 held-out tickets for a fair evaluation
  kb.json                  10 starter knowledge-base articles (seeded into the KB)
scripts/
  seed.js                  wipe + seed MongoDB
  smoke-test.js            npm test
  evaluate.js              npm run evaluate
docs/evaluation-results.md latest evaluation output
views/                   EJS templates (partials/layout-top.ejs = app shell, partials/ticket-strip.ejs = flight strip)
src/styles/app.css       Tailwind source: design tokens, components, dark mode
public/css/app.css       compiled CSS (npm run build:css)
public/js/app.js         theme toggle, mobile menu, "/" shortcut, confirm-before-merge
public/fonts/            IBM Plex (OFL licence)
```
