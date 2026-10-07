// Stretch feature 1: auto-categorization and routing.
//
// Category: k-nearest-neighbours over existing tickets. The new ticket's
// text is compared with every existing ticket (embeddings + cosine when an
// API key is set, otherwise the keyword Jaccard baseline), and the K most
// similar tickets vote for their category, weighted by similarity. The
// result is only a SUGGESTION - the user can change it before submitting.
//
// Assignee: the agent with the fewest active (In Progress) tickets. Shown
// to staff as a suggestion; a manager can apply it with one click.

const store = require('./store');
const embeddings = require('./embeddings');
const { ensureEmbeddings } = require('./duplicates');
const { cosineSimilarity, tokenize, jaccardSimilarity } = require('./similarity');
const { CATEGORIES } = require('./constants');

const K = 5;

function vote(scored) {
  const top = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, K);
  if (top.length === 0) return null;
  const weights = {};
  top.forEach((s) => {
    weights[s.category] = (weights[s.category] || 0) + s.score;
  });
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const [category, weight] = Object.entries(weights).sort((a, b) => b[1] - a[1])[0];
  if (!CATEGORIES.includes(category)) return null;
  return {
    category,
    confidence: Math.round((weight / total) * 100) / 100,
    neighbours: top.map((s) => ({ ticketId: s.ticketId, category: s.category, score: Math.round(s.score * 1000) / 1000 })),
  };
}

// Never throws: falls back to the keyword method if embeddings fail, and
// returns null if there's nothing to go on.
async function suggestCategory({ title, description }) {
  const text = `${title || ''} ${description || ''}`.trim();
  if (!text) return null;
  const existing = await store.listTickets({}, { withEmbeddings: true });
  if (existing.length === 0) return null;

  if (embeddings.isConfigured()) {
    try {
      const ready = await ensureEmbeddings(existing);
      const embedded = await embeddings.embedTexts([embeddings.ticketText({ title, description })]);
      if (ready.status === 'ok' && embedded.status === 'ok') {
        const vector = embedded.vectors[0];
        const scored = existing
          .filter((t) => t.embeddingModel === embedded.model)
          .map((t) => ({ ticketId: t.ticketId, category: t.category, score: cosineSimilarity(vector, t.embedding) }));
        const result = vote(scored);
        if (result) return { ...result, method: 'ai' };
      }
    } catch (err) {
      console.error('AI categorization failed, using keyword fallback:', err.message);
    }
  }

  const tokens = tokenize(text);
  const scored = existing.map((t) => ({
    ticketId: t.ticketId,
    category: t.category,
    score: jaccardSimilarity(tokens, tokenize(`${t.title} ${t.description}`)),
  }));
  const result = vote(scored);
  return result ? { ...result, method: 'keyword' } : null;
}

// Agents sorted by current workload (In Progress tickets), lightest first.
async function agentWorkloads() {
  const agents = await store.listUsers({ role: 'agent' });
  const active = await store.listTickets({ status: 'In Progress' });
  return agents
    .map((a) => ({
      name: a.name,
      email: a.email,
      active: active.filter((t) => t.assigneeEmail === a.email).length,
    }))
    .sort((a, b) => a.active - b.active || a.name.localeCompare(b.name));
}

async function suggestAssignee() {
  const loads = await agentWorkloads();
  return loads[0] || null;
}

module.exports = { suggestCategory, suggestAssignee, agentWorkloads };
