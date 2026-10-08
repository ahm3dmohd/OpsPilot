// In-app notifications for ticket events. Who hears about what:
//
//   created (Urgent only) -> every agent
//   claimed               -> requester
//   assigned by manager   -> requester + the assigned agent
//   status changed        -> requester + assignee
//   commented             -> requester + assignee
//   merged as duplicate   -> requester of the merged ticket
//
// The person who did the action is never notified about it. Like the
// audit log, this never throws: a failed notification must not undo or
// break the action that triggered it.
const store = require('./store');

function unique(emails) {
  return [...new Set(emails.filter(Boolean))];
}

async function send(recipients, actor, ticket, message) {
  const to = unique(recipients).filter((email) => email !== actor.email);
  if (to.length === 0) return;
  try {
    await store.createNotifications(to.map((userEmail) => ({ userEmail, ticketId: ticket.ticketId, message })));
  } catch (err) {
    console.error('Notification write failed:', err.message);
  }
}

const ref = (t) => `${t.ticketId} "${t.title}"`;

async function ticketCreated(ticket, actor) {
  if (ticket.priority !== 'Urgent') return;
  try {
    const agents = await store.listUsers({ role: 'agent' });
    await send(agents.map((a) => a.email), actor, ticket, `New Urgent ticket ${ref(ticket)} from ${actor.name}`);
  } catch (err) {
    console.error('Notification failed:', err.message);
  }
}

const ticketClaimed = (ticket, actor) =>
  send([ticket.requesterEmail], actor, ticket, `${actor.name} is now working on your ticket ${ref(ticket)}`);

const ticketAssigned = (ticket, actor) =>
  send([ticket.requesterEmail, ticket.assigneeEmail], actor, ticket, `${actor.name} assigned ${ref(ticket)} to ${ticket.assigneeName}`);

const statusChanged = (ticket, actor, from) =>
  send([ticket.requesterEmail, ticket.assigneeEmail], actor, ticket, `${actor.name} moved ${ref(ticket)} from ${from} to ${ticket.status}`);

const commented = (ticket, actor) =>
  send([ticket.requesterEmail, ticket.assigneeEmail], actor, ticket, `${actor.name} commented on ${ref(ticket)}`);

// Only the requester of the merged ticket hears about a merge. The message
// doesn't name the other ticket: it is usually someone else's, which end
// users can't open.
const mergedAsDuplicate = (ticket, actor) =>
  send([ticket.requesterEmail], actor, ticket, `${actor.name} closed ${ref(ticket)} as a duplicate of an issue IT is already working on`);

module.exports = { ticketCreated, ticketClaimed, ticketAssigned, statusChanged, commented, mergedAsDuplicate };
