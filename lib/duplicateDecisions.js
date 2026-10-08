// Agent decisions on suggested duplicates: Confirm (= merge) or Reject.
//
// Every decision is stored (lib/store.js, DuplicateDecision) with the
// scores both methods gave the pair, so the report can measure how often
// each method's suggestions were real duplicates. That is PRECISION only:
// duplicates that no method suggested never reach an agent, so recall
// can't be measured from this data.
//
// Confirming merges the NEWER ticket into the OLDER one:
//   - the newer ticket is closed and gets mergedInto = older ID;
//   - the older ticket gets a staff-only internal note with a full copy of
//     the newer ticket's description, comments and internal notes;
//   - nothing on the newer ticket is changed or deleted apart from its
//     status and merge fields. Its comments are copied as an INTERNAL
//     note, not as comments, because the two requesters are usually
//     different people and end users never see each other's tickets.
const store = require('./store');
const notify = require('./notify');
const { pairKey, forgetSuggestions } = require('./duplicates');

const REASONS = {
  not_found: 'not_found',
  not_suggested: 'not_suggested', // pair isn't in the current suggestions
  already_decided: 'already_decided',
  already_merged: 'already_merged', // one of the two was merged earlier
};

function findMatch(ticket, otherId) {
  const d = ticket && ticket.duplicates;
  const result = {};
  if (!d) return result;
  ['ai', 'baseline'].forEach((method) => {
    const r = d[method];
    if (!r || r.status !== 'ok') return;
    const m = r.matches.find((x) => x.ticketId === otherId);
    if (m) result[method] = { score: m.score, threshold: r.threshold, model: r.model || null };
  });
  return result;
}

// Looks the pair up in the stored suggestions of BOTH tickets (they may
// have been checked at different times). Scores come from the server's own
// stored results, never from the form.
function suggestionFor(a, b) {
  const fromA = findMatch(a, b.ticketId);
  const fromB = findMatch(b, a.ticketId);
  const ai = fromA.ai || fromB.ai || null;
  const baseline = fromA.baseline || fromB.baseline || null;
  if (!ai && !baseline) return null;
  return {
    flaggedBy: ai && baseline ? 'both' : ai ? 'ai' : 'baseline',
    aiScore: ai ? ai.score : null,
    baselineScore: baseline ? baseline.score : null,
    aiThreshold: ai ? ai.threshold : null,
    baselineThreshold: baseline ? baseline.threshold : null,
    aiModel: ai ? ai.model : null,
  };
}

async function loadPair(ticketId, candidateId) {
  if (ticketId === candidateId) return { reason: REASONS.not_suggested };
  const [ticket, candidate] = await Promise.all([store.getTicketById(ticketId), store.getTicketById(candidateId)]);
  if (!ticket || !candidate) return { reason: REASONS.not_found };
  if (ticket.mergedInto || candidate.mergedInto) return { reason: REASONS.already_merged };
  const suggestion = suggestionFor(ticket, candidate);
  if (!suggestion) return { reason: REASONS.not_suggested };
  return { ticket, candidate, suggestion };
}

function decisionRecord(ticket, candidate, suggestion, decision, user, extra = {}) {
  return {
    pairKey: pairKey(ticket.ticketId, candidate.ticketId),
    ticketId: ticket.ticketId,
    candidateId: candidate.ticketId,
    decision,
    ...suggestion,
    primaryId: null,
    mergedId: null,
    ...extra,
    byEmail: user.email,
    byName: user.name,
  };
}

const ticketNum = (t) => parseInt(String(t.ticketId).slice(2), 10) || 0;

// Older = created first (ticket number breaks a tie).
function orderPair(a, b) {
  const diff = new Date(a.createdAt) - new Date(b.createdAt);
  const aFirst = diff < 0 || (diff === 0 && ticketNum(a) < ticketNum(b));
  return aFirst ? [a, b] : [b, a];
}

const stamp = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

// The copy of the merged ticket that goes on the primary ticket.
function mergeNoteBody(dup, dupNotes) {
  const lines = [
    `Merged ${dup.ticketId} "${dup.title}" into this ticket (confirmed duplicate).`,
    `Requester: ${dup.requesterName} <${dup.requesterEmail}>, opened ${stamp(dup.createdAt)}, ${dup.priority} priority, ${dup.category}.`,
    '',
    'Description:',
    dup.description,
  ];
  const comments = dup.comments || [];
  lines.push('', `Comments (${comments.length}):`);
  if (comments.length === 0) lines.push('(none)');
  comments.forEach((c) => lines.push(`[${stamp(c.createdAt)}] ${c.authorName}${c.authorRole && c.authorRole !== 'end_user' ? ' (IT staff)' : ''}: ${c.body}`));
  if (dupNotes.length) {
    lines.push('', `Internal notes (${dupNotes.length}):`);
    dupNotes.forEach((n) => lines.push(`[${stamp(n.createdAt)}] ${n.authorName}: ${n.body}`));
  }
  lines.push('', `The original stays readable at ${dup.ticketId}.`);
  return lines.join('\n');
}

// Returns { primary, merged } or { reason }.
async function confirm(ticketId, candidateId, user) {
  const pair = await loadPair(String(ticketId), String(candidateId));
  if (pair.reason) return pair;
  const { ticket, candidate, suggestion } = pair;
  const [primary, dup] = orderPair(ticket, candidate);

  // Record first: the unique pairKey makes sure only one agent decides.
  const record = decisionRecord(ticket, candidate, suggestion, 'confirmed', user, { primaryId: primary.ticketId, mergedId: dup.ticketId });
  if (!(await store.createDuplicateDecision(record))) return { reason: REASONS.already_decided };

  const now = new Date();
  const set = { mergedInto: primary.ticketId, mergedAt: now, mergedByEmail: user.email, status: 'Closed' };
  if (!dup.firstResponseAt) set.firstResponseAt = now;
  if (!dup.resolvedAt) set.resolvedAt = now;
  const push = {};
  if (dup.status !== 'Closed') push.statusHistory = { status: 'Closed', at: now, byEmail: user.email, reason: `Merged into ${primary.ticketId}` };
  // Conditional: if someone merged it elsewhere a moment ago, back out.
  const merged = await store.updateTicket(dup.ticketId, { set, push, where: { mergedInto: null } });
  if (!merged) {
    await store.deleteDuplicateDecision(record.pairKey);
    return { reason: REASONS.already_merged };
  }

  const dupNotes = await store.listInternalNotes(dup.ticketId);
  await store.addInternalNote({
    ticketId: primary.ticketId,
    authorEmail: user.email,
    authorName: user.name,
    authorRole: user.role,
    body: mergeNoteBody(dup, dupNotes),
  });
  // The merged ticket is never suggested again, anywhere.
  await forgetSuggestions((owner, match) => owner === dup.ticketId || match === dup.ticketId);
  await notify.mergedAsDuplicate(merged, user);
  return { primary, merged };
}

// Returns { decision } or { reason }.
async function reject(ticketId, candidateId, user) {
  const pair = await loadPair(String(ticketId), String(candidateId));
  if (pair.reason) return pair;
  const { ticket, candidate, suggestion } = pair;
  const decision = await store.createDuplicateDecision(decisionRecord(ticket, candidate, suggestion, 'rejected', user));
  if (!decision) return { reason: REASONS.already_decided };
  const key = decision.pairKey;
  await forgetSuggestions((owner, match) => pairKey(owner, match) === key);
  return { decision };
}

// ---- Stats for the thesis ----
function rate(list) {
  const confirmed = list.filter((d) => d.decision === 'confirmed').length;
  return {
    decided: list.length,
    confirmed,
    rejected: list.length - confirmed,
    // Share of decided suggestions that were real duplicates (precision).
    rate: list.length ? confirmed / list.length : null,
  };
}

// Pairs still waiting for a decision, from the stored suggestions.
function pendingPairs(tickets, decidedKeys) {
  const pairs = new Map();
  tickets.forEach((t) => {
    if (!t.duplicates || t.mergedInto) return;
    ['ai', 'baseline'].forEach((method) => {
      const r = t.duplicates[method];
      if (!r || r.status !== 'ok') return;
      r.matches.forEach((m) => {
        const key = pairKey(t.ticketId, m.ticketId);
        if (decidedKeys.has(key)) return;
        const p = pairs.get(key) || { ai: false, baseline: false };
        p[method] = true;
        pairs.set(key, p);
      });
    });
  });
  return [...pairs.values()];
}

async function stats() {
  const [decisions, tickets] = await Promise.all([store.listDuplicateDecisions(), store.listTickets({})]);
  const pending = pendingPairs(tickets, new Set(decisions.map((d) => d.pairKey)));
  const groups = [
    ['All suggestions', () => true, () => true],
    ['Flagged by AI', (d) => d.flaggedBy !== 'baseline', (p) => p.ai],
    ['Flagged by baseline', (d) => d.flaggedBy !== 'ai', (p) => p.baseline],
    ['Flagged by both', (d) => d.flaggedBy === 'both', (p) => p.ai && p.baseline],
    ['AI only', (d) => d.flaggedBy === 'ai', (p) => p.ai && !p.baseline],
    ['Baseline only', (d) => d.flaggedBy === 'baseline', (p) => p.baseline && !p.ai],
  ];
  const rows = groups.map(([label, isDecision, isPending]) => {
    const r = rate(decisions.filter(isDecision));
    const waiting = pending.filter(isPending).length;
    return { label, ...r, pending: waiting, total: r.decided + waiting };
  });
  return { rows, decisions: decisions.slice().reverse() };
}

module.exports = { confirm, reject, stats, suggestionFor, orderPair, REASONS };
