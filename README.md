# OpsPilot

A HelpDesk / ITSM ticketing system built as a Bahrain Polytechnic
Cooperative Learning Project (CLP) capstone. General-purpose IT helpdesk
(not tied to any specific company), with three real roles and an
AI-assisted duplicate-ticket detection feature.

## Roles

- **End User** - submits tickets, sees their own ticket list and status
- **Agent** - works the open queue, claims tickets, updates status, comments
- **Manager** - overview dashboard: ticket volume by status/category, agent
  workload, full ticket list

Real authentication: sessions + hashed passwords, role-based route access
(an End User can't open the agent queue, an Agent can't see the manager
dashboard, etc).

## Stack

Node.js, Express, EJS, MongoDB Atlas (Vector Search, from Week 3 onward),
an LLM API for embeddings. One process, server-rendered pages - no
separate frontend to run.

## Getting started

```bash
npm install
npm run dev
```

Runs on `http://localhost:3000` with **no `.env` file required**. With no
`MONGODB_URI` set, the app runs in mock-data mode: users and tickets live
in memory, seeded automatically on startup.

**Demo logins (mock mode), password `password123` for all three:**
- `enduser@opspilot.test` - End User
- `agent@opspilot.test` - Agent
- `manager@opspilot.test` - Manager

(The registration page also lets you create a new account and pick a role
directly - that's a demo convenience, not something a real deployment
would allow.)

Once you're ready for real persistence: `cp .env.example .env`, fill in
`MONGODB_URI` (and `LLM_API_KEY` for Week 3), then `npm run seed` to load
the same demo users and tickets into MongoDB. Every route works
identically either way - `lib/store.js` is the one place that branches on
whether a database is connected.

## Ticket workflow

Status: `Open` → `In Progress` → `Resolved` → `Closed`
Priority: `Low` / `Medium` / `High` / `Urgent`
Each ticket has a comment/activity thread, visible to its requester, any
agent, and any manager.

## Project structure

```
server.js              entry point, sessions, mounts routes
routes/
  auth.routes.js          login, register, logout
  dashboard.routes.js      role-based dashboard (end user / agent / manager)
  tickets.routes.js        create, view, claim, status change, comment
middleware/auth.js       requireLogin / requireRole route guards
models/                 Mongoose schemas (User, Ticket, AuditLog)
lib/store.js            data access layer - branches on DB vs mock mode
data/tickets.json        synthetic seed tickets (see below)
views/                  EJS templates
public/css/style.css     shared styling
scripts/seed.js          loads demo users + tickets into MongoDB
```

## Seed data: why it's synthetic

`data/tickets.json` is a synthetic set of 20 generic IT helpdesk tickets -
realistic wording, but no real person or real company. It's written to
contain **deliberate near-duplicate clusters**: four VPN-dropping tickets,
three account-lockout tickets, two offline-printer tickets, two
slow-laptop tickets, two email-sync tickets, two software-license
requests. This isn't filler - it's what Week 3's duplicate-detection
feature needs to prove itself against: you can state exactly what the
system *should* flag as related, and check whether it did, which is the
whole point of the AI-vs-baseline comparison in the thesis evaluation.

## What's real vs. stub right now

- Login/register/logout, role-based dashboards, ticket submission, the
  agent queue, claiming, status changes, and the comment thread are all
  live and working end to end (verified against mock data before this was
  handed over).
- Duplicate/similar-ticket detection (the Week 3 AI feature) isn't built
  yet - `embedding` and `similarTicketIds` fields already exist on the
  Ticket model, ready for Week 3 to fill in.

## Build plan

See the "OpsPilot - 30-Day Build Plan" doc for the week-by-week schedule.
Current status: Week 1 foundation (auth, roles, ticket data model,
dashboards) and Week 2's core ticket workflow are both done ahead of
schedule; Week 3 (duplicate detection) is next.
