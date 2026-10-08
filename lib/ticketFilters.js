// Ticket filters shared by the filtered ticket list (/tickets), the CSV
// export and the manager dashboard.
//
// The dashboard computes every number it shows by running the SAME filter
// its link opens, so a number and the list it links to can never disagree
// (e.g. "5 breached" always opens a list of exactly 5 tickets).
//
// Filters come from the query string. Unknown keys and invalid values are
// ignored rather than erroring, so a hand-edited URL can't break the page.

const { STATUSES, PRIORITIES, CATEGORIES, TICKET_TYPES, TYPE_LABELS } = require('./constants');
const { slaFor } = require('./sla');

const ACTIVE = ['Open', 'In Progress'];

const SLA_LABELS = { breached: 'SLA breached', at_risk: 'SLA at risk', ok: 'SLA on track', met: 'SLA met', waiting: 'SLA not started (awaiting approval)' };
const DUP_LABELS = {
  checked: 'Checked for duplicates',
  ai: 'Flagged by AI method',
  baseline: 'Flagged by keyword baseline',
  ai_skipped: 'AI method skipped/failed',
  both: 'Flagged by both methods',
  ai_only: 'Flagged by AI only',
  baseline_only: 'Flagged by baseline only',
};
const SUGGESTION_LABELS = { any: 'Category was suggested', accepted: 'Suggested category kept', changed: 'Suggested category changed' };

const hasMatches = (r) => !!r && r.status === 'ok' && r.matches.length > 0;

// Each filter: how to validate the raw value, how to test a ticket, and
// how to describe it in a chip.
const DEFS = {
  status: {
    valid: (v) => STATUSES.includes(v),
    test: (t, v) => t.status === v,
    label: (v) => `Status: ${v}`,
  },
  state: {
    valid: (v) => v === 'active',
    test: (t) => ACTIVE.includes(t.status),
    label: () => 'Active (Open or In Progress)',
  },
  type: {
    valid: (v) => TICKET_TYPES.includes(v),
    test: (t, v) => (t.type || 'incident') === v,
    label: (v) => `Type: ${TYPE_LABELS[v]}`,
  },
  department: {
    // Departments live in the database, so only the code's shape is
    // checked here; an unknown code just matches nothing.
    valid: (v) => /^[A-Z][A-Z0-9-]{0,11}$/.test(v),
    test: (t, v) => (t.department || 'IT') === v,
    label: (v, ctx) => `Department: ${ctx && ctx.deptName ? ctx.deptName(v) : v}`,
  },
  category: {
    valid: (v) => CATEGORIES.includes(v),
    test: (t, v) => t.category === v,
    label: (v) => `Category: ${v}`,
  },
  priority: {
    valid: (v) => PRIORITIES.includes(v),
    test: (t, v) => t.priority === v,
    label: (v) => `Priority: ${v}`,
  },
  assignee: {
    valid: (v) => v === 'unassigned' || /^[^\s@]+@[^\s@]+$/.test(v),
    test: (t, v) => (v === 'unassigned' ? !t.assigneeEmail : t.assigneeEmail === v),
    label: (v, ctx) => (v === 'unassigned' ? 'Unassigned' : `Assigned to ${ctx.nameOf(v)}`),
  },
  sla: {
    valid: (v) => !!SLA_LABELS[v],
    test: (t, v) => t.sla.overall === v,
    label: (v) => SLA_LABELS[v],
  },
  dup: {
    valid: (v) => !!DUP_LABELS[v],
    test: (t, v) => {
      const d = t.duplicates;
      if (!d) return false;
      const ai = hasMatches(d.ai);
      const kw = hasMatches(d.baseline);
      return {
        checked: true,
        ai,
        baseline: kw,
        ai_skipped: d.ai.status !== 'ok',
        both: ai && kw,
        ai_only: ai && !kw,
        baseline_only: kw && !ai,
      }[v];
    },
    label: (v) => DUP_LABELS[v],
  },
  suggestion: {
    valid: (v) => !!SUGGESTION_LABELS[v],
    test: (t, v) => {
      const s = t.categorySuggestion;
      if (!s) return false;
      return v === 'any' || (v === 'accepted' ? s.accepted : !s.accepted);
    },
    label: (v) => SUGGESTION_LABELS[v],
  },
  q: {
    valid: (v) => v.length > 0,
    test: (t, v) => `${t.ticketId} ${t.title} ${t.description} ${t.requesterName}`.toLowerCase().includes(v.toLowerCase()),
    label: (v) => `Search: "${v}"`,
  },
};

const KEYS = Object.keys(DEFS);

// Query object -> { key: value } with only valid filters kept.
function parseFilters(query = {}) {
  const filters = {};
  KEYS.forEach((key) => {
    const raw = query[key];
    if (typeof raw !== 'string') return; // ignores arrays from ?x=1&x=2
    const value = key === 'q' ? raw.trim().slice(0, 100) : raw;
    if (DEFS[key].valid(value)) filters[key] = value;
  });
  return filters;
}

// Adds `.sla` to each ticket (needed by the sla filter and the tables).
function withSla(tickets, now = new Date()) {
  return tickets.map((t) => (t.sla ? t : { ...t, sla: slaFor(t, now) }));
}

function applyFilters(ticketsWithSla, filters) {
  const active = Object.entries(filters);
  return ticketsWithSla.filter((t) => active.every(([key, value]) => DEFS[key].test(t, value)));
}

function toQuery(filters) {
  const params = new URLSearchParams();
  KEYS.forEach((key) => {
    if (filters[key]) params.set(key, filters[key]);
  });
  const s = params.toString();
  return s ? `?${s}` : '';
}

function listUrl(filters) {
  return `/tickets${toQuery(filters)}`;
}

// One removable chip per active filter.
function chips(filters, ctx) {
  return Object.keys(filters).map((key) => {
    const rest = { ...filters };
    delete rest[key];
    return { label: DEFS[key].label(filters[key], ctx), removeUrl: listUrl(rest) };
  });
}

// For the dashboard: the count AND the link for one filter, computed
// together so they always agree.
function stat(ticketsWithSla, filters) {
  return { count: applyFilters(ticketsWithSla, filters).length, href: listUrl(filters) };
}

module.exports = {
  parseFilters,
  applyFilters,
  withSla,
  toQuery,
  listUrl,
  chips,
  stat,
  SLA_LABELS,
  DUP_LABELS,
  SUGGESTION_LABELS,
  ACTIVE,
};
