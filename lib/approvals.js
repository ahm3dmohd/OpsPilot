// Approval workflow for Service Requests. Incidents never come here.
//
// The chain, stored as one ApprovalStep per step when the request is made:
//   1. line_manager    - the requester's line manager
//   2. requester_head  - head of the requester's own department
//   3. target_head     - head of the department that will do the work
//                        (only when that's a different department)
// Then the ticket becomes Open in the target department's queue.
//
// Edge cases, all decided on the server:
//   - No line manager: step 1 is stored as skipped.
//   - Target department = requester's department: step 3 is stored as
//     skipped (its head already approves at step 2).
//   - Nobody approves their own request: a step whose approver is the
//     requester is skipped when it's reached; reassigning a step to the
//     requester is refused; deciding on your own request is refused.
//   - The same person isn't asked twice: a step whose approver already
//     approved an earlier step of the same request is skipped.
//   - No department head (or the requester has no department): the step
//     waits UNASSIGNED until an admin assigns an approver, or until that
//     department gets a head (assignHeadSteps). It is never skipped.
//   - Approver changes role / leaves: admins reassign the open step
//     (/admin/approvals flags steps whose approver no longer matches).
//   - Only the step's designated approver can decide it (checked here,
//     with a conditional update so a double click can't decide twice).
//   - Rejection needs a reason, ends the chain (remaining steps stored as
//     skipped) and notifies the requester.
// Skip decisions are made when a step is REACHED, so they use the org
// chart as it is then, not as it was at submission.
const store = require('./store');
const notify = require('./notify');

const KIND_LABELS = {
  line_manager: 'Line manager',
  requester_head: "Head of requester's department",
  target_head: 'Head of target department',
};
const MAX_COMMENT = 1000;
const OPEN_STEP = ['waiting', 'pending'];

async function plan(ticket, requester) {
  const steps = [];
  steps.push(requester.managerEmail
    ? { order: 1, kind: 'line_manager', approverEmail: requester.managerEmail }
    : { order: 1, kind: 'line_manager', status: 'skipped', comment: 'The requester has no line manager.' });

  const ownDept = requester.department ? await store.getDepartment(requester.department) : null;
  steps.push({
    order: 2,
    kind: 'requester_head',
    department: requester.department || null,
    approverEmail: ownDept ? ownDept.headEmail : null,
    comment: requester.department ? null : 'The requester has no department. An admin must choose the approver.',
  });

  if (requester.department && requester.department === ticket.department) {
    steps.push({ order: 3, kind: 'target_head', department: ticket.department, status: 'skipped',
      comment: "Same department as the requester's: its head approves at step 2." });
  } else {
    const target = await store.getDepartment(ticket.department);
    steps.push({ order: 3, kind: 'target_head', department: ticket.department, approverEmail: target ? target.headEmail : null });
  }
  return steps.map((s) => ({ ticketId: ticket.ticketId, status: 'waiting', department: null, approverEmail: null, comment: null, ...s }));
}

const skip = (step, comment) =>
  store.updateApprovalStep(step.id, { set: { status: 'skipped', comment, decidedAt: new Date() }, where: { status: 'waiting' } });

// Moves to the next step that needs a person, skipping as described above.
// Returns the step now pending, or null when every step is done.
async function advance(ticket, actor) {
  const steps = await store.listApprovalSteps({ ticketId: ticket.ticketId });
  const approvedBy = new Map(steps.filter((s) => s.status === 'approved').map((s) => [s.approverEmail, s.order]));
  for (const step of steps) {
    if (step.status !== 'waiting') continue;
    if (step.approverEmail && step.approverEmail === ticket.requesterEmail) {
      await skip(step, 'The requester is this approver, and nobody approves their own request.');
      continue;
    }
    if (step.approverEmail && approvedBy.has(step.approverEmail)) {
      await skip(step, `Same person already approved at step ${approvedBy.get(step.approverEmail)}.`);
      continue;
    }
    const pending = await store.updateApprovalStep(step.id, { set: { status: 'pending' }, where: { status: 'waiting' } });
    if (pending && pending.approverEmail) await notify.approvalNeeded(ticket, pending.approverEmail, actor);
    return pending;
  }
  return null;
}

async function finishApproved(ticket, actor) {
  const now = new Date();
  const updated = await store.updateTicket(ticket.ticketId, {
    set: { status: 'Open', approvalState: 'approved', approvedAt: now },
    push: { statusHistory: { status: 'Open', at: now, byEmail: actor.email, reason: 'Approved' } },
    where: { status: 'Pending Approval' },
  });
  if (updated) await notify.requestApproved(updated, actor);
  return updated;
}

// Called right after a Service Request is created (status Pending Approval).
// If every step is skipped (e.g. a department head requesting for their
// own department, with no line manager) it is approved straight away.
async function start(ticket, requester) {
  const fullRequester = (await store.findUserByEmail(requester.email)) || requester;
  await store.createApprovalSteps(await plan(ticket, fullRequester));
  const pending = await advance(ticket, requester);
  if (!pending) return { ticket: await finishApproved(ticket, requester), autoApproved: true };
  return { ticket, pending };
}

// decision: 'approve' | 'reject'. Returns { ticket, step, finished } or { reason }.
async function decide(stepId, user, decision, comment) {
  const step = await store.getApprovalStep(String(stepId));
  if (!step) return { reason: 'not_found' };
  const ticket = await store.getTicketById(step.ticketId);
  if (!ticket) return { reason: 'not_found' };
  if (step.approverEmail !== user.email) return { reason: 'not_approver' };
  if (ticket.requesterEmail === user.email) return { reason: 'own_request' };
  if (step.status !== 'pending' || ticket.status !== 'Pending Approval') return { reason: 'not_pending' };
  const text = String(comment || '').trim().slice(0, MAX_COMMENT);
  if (decision === 'reject' && !text) return { reason: 'reason_required' };

  const now = new Date();
  const decided = await store.updateApprovalStep(step.id, {
    set: { status: decision === 'approve' ? 'approved' : 'rejected', comment: text || null, decidedByEmail: user.email, decidedAt: now },
    where: { status: 'pending', approverEmail: user.email },
  });
  if (!decided) return { reason: 'not_pending' };

  if (decision === 'reject') {
    const rest = (await store.listApprovalSteps({ ticketId: ticket.ticketId })).filter((s) => s.status === 'waiting');
    for (const s of rest) await skip(s, `Not needed: rejected at step ${step.order}.`);
    const updated = await store.updateTicket(ticket.ticketId, {
      set: { status: 'Rejected', approvalState: 'rejected', rejectionReason: text },
      push: { statusHistory: { status: 'Rejected', at: now, byEmail: user.email, reason: 'Not approved' } },
      where: { status: 'Pending Approval' },
    });
    if (updated) await notify.requestRejected(updated, user, text);
    return { ticket: updated || ticket, step: decided, finished: true };
  }

  const next = await advance(ticket, user);
  if (next) return { ticket, step: decided, finished: false, next };
  return { ticket: (await finishApproved(ticket, user)) || ticket, step: decided, finished: true };
}

// Admin: give an open step to someone else. Returns { step, from } or { reason }.
async function reassign(stepId, admin, newEmail) {
  const step = await store.getApprovalStep(String(stepId));
  if (!step) return { reason: 'not_found' };
  if (!OPEN_STEP.includes(step.status)) return { reason: 'not_open' };
  const ticket = await store.getTicketById(step.ticketId);
  const user = await store.findUserByEmail(String(newEmail || ''));
  if (!ticket || !user) return { reason: 'bad_user' };
  if (user.email === ticket.requesterEmail) return { reason: 'own_request' };
  if (user.email === step.approverEmail) return { reason: 'unchanged' };
  const updated = await store.updateApprovalStep(step.id, {
    set: { approverEmail: user.email },
    push: { reassignments: { at: new Date(), byEmail: admin.email, from: step.approverEmail, to: user.email } },
    where: { status: step.status },
  });
  if (!updated) return { reason: 'not_open' };
  if (updated.status === 'pending') await notify.approvalNeeded(ticket, user.email, admin);
  return { step: updated, from: step.approverEmail };
}

// When a department gets a head, give them its unassigned head steps
// (except on requests they made themselves - those stay for an admin).
async function assignHeadSteps(code, headEmail, actor) {
  if (!headEmail) return 0;
  const steps = (await store.listApprovalSteps({ department: code, approverEmail: null }))
    .filter((s) => s.kind !== 'line_manager' && OPEN_STEP.includes(s.status));
  let assigned = 0;
  for (const s of steps) {
    const ticket = await store.getTicketById(s.ticketId);
    if (!ticket || ticket.requesterEmail === headEmail) continue;
    const r = await reassign(s.id, actor, headEmail);
    if (r.step) assigned += 1;
  }
  return assigned;
}

// Who SHOULD approve this step according to the org chart now - used to
// flag steps whose approver changed role, moved or left.
function expectedApprover(step, ticket, usersByEmail, deptByCode) {
  if (step.kind === 'line_manager') return ((usersByEmail.get(ticket.requesterEmail) || {}).managerEmail) || null;
  return ((deptByCode.get(step.department) || {}).headEmail) || null;
}

// Open steps with a "stale" flag, for the admin page.
async function openSteps() {
  const [steps, users, departments] = await Promise.all([
    store.listApprovalSteps({ status: { $in: OPEN_STEP } }), store.listUsers(), store.listDepartments(),
  ]);
  const usersByEmail = new Map(users.map((u) => [u.email, u]));
  const deptByCode = new Map(departments.map((d) => [d.code, d]));
  const tickets = new Map((await store.listTickets({ status: 'Pending Approval' })).map((t) => [t.ticketId, t]));
  return steps.filter((s) => tickets.has(s.ticketId)).map((s) => {
    const ticket = tickets.get(s.ticketId);
    const expected = expectedApprover(s, ticket, usersByEmail, deptByCode);
    let problem = null;
    if (!s.approverEmail) problem = 'Unassigned: choose an approver.';
    else if (!usersByEmail.has(s.approverEmail)) problem = 'The approver is no longer a user.';
    else if (expected && expected !== s.approverEmail && expected !== ticket.requesterEmail) {
      problem = `The org chart changed: ${(usersByEmail.get(expected) || {}).name || expected} is now the ${KIND_LABELS[s.kind].toLowerCase()}.`;
    }
    return { ...s, ticket, expected, problem };
  });
}

module.exports = { start, decide, reassign, assignHeadSteps, openSteps, plan, KIND_LABELS, MAX_COMMENT };
