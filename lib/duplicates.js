// Duplicate / similar-ticket detection. Two INDEPENDENT methods run on
// every new ticket, and their results are stored side by side (never
// merged) so they can be compared in the AI-vs-baseline evaluation:
//
//   ai       - embeddings + cosine similarity (lib/embeddings.js)
//   baseline - hand-written tokenizer + Jaccard similarity (lib/similarity.js)
//
// Stored on the ticket as `duplicates`:
//   {
//     ai:       { status: 'ok'|'skipped'|'error', reason?, model?, threshold,
//                 matches: [{ ticketId, title, status, score }], ranAt },
//     baseline: { status: 'ok', threshold, matches: [...], ranAt },
//     comparedAgainst: <number of other tickets checked>
//   }

const store = require('./store');
const embeddings = require('./embeddings');
const { cosineSimilarity, tokenize, jaccardSimilarity } = require('./similarity');

const TOP_K = 5;

// Default thresholds. Each embedding model spreads its scores differently,
// so one AI number does not fit both providers. gemini's (0.88) and the
// baseline's (0.10) are each method's best-F1 threshold on the seed set
// from `npm run evaluate` - tuned the same way, so the comparison is fair.
// openai's 0.82 is the usual starting point for text-embedding-3-small and
// has NOT been calibrated here. AI_SIMILARITY_THRESHOLD /
// BASELINE_SIMILARITY_THRESHOLD in .env override these.
const DEFAULT_AI_THRESHOLDS = { gemini: 0.88, openai: 0.82 };
const DEFAULT_BASELINE_THRESHOLD = 0.1;

function aiThreshold() {
  const fromEnv = parseFloat(process.env.AI_SIMILARITY_THRESHOLD);
  if (!Number.isNaN(fromEnv)) return fromEnv;
  const provider = (embeddings.modelLabel() || 'openai/').split('/')[0];
  return DEFAULT_AI_THRESHOLDS[provider] || 0.82;
}

function baselineThreshold() {
  const fromEnv = parseFloat(process.env.BASELINE_SIMILARITY_THRESHOLD);
  return Number.isNaN(fromEnv) ? DEFAULT_BASELINE_THRESHOLD : fromEnv;
}

function topMatches(scored, threshold) {
  return scored
    .filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K)
    .map((m) => ({ ...m, score: Math.round(m.score * 1000) / 1000 }));
}

function summary(t) {
  return { ticketId: t.ticketId, title: t.title, status: t.status };
}

// ---- Baseline: keyword Jaccard ----
// Pure function: no I/O, can't fail.
function baselineScores(ticket, candidates) {
  const tokens = tokenize(`${ticket.title} ${ticket.description}`);
  return candidates.map((c) => ({
    ...summary(c),
    score: jaccardSimilarity(tokens, tokenize(`${c.title} ${c.description}`)),
  }));
}

function findBaselineMatches(ticket, candidates, threshold = baselineThreshold()) {
  return {
    status: 'ok',
    method: 'jaccard',
    threshold,
    matches: topMatches(baselineScores(ticket, candidates), threshold),
    ranAt: new Date(),
  };
}

// ---- AI: embeddings + cosine ----
// Makes sure every given ticket has an embedding from the CURRENT model,
// embedding any that are missing in one batched call and saving them.
// Returns { status, model, reason } - never throws.
async function ensureEmbeddings(tickets) {
  const model = embeddings.modelLabel();
  if (!model) return { status: 'skipped', reason: 'No LLM_API_KEY configured' };
  const missing = tickets.filter((t) => t.embeddingModel !== model || !t.embedding || t.embedding.length === 0);
  if (missing.length === 0) return { status: 'ok', model };
  const result = await embeddings.embedTexts(missing.map(embeddings.ticketText));
  if (result.status !== 'ok') return result;
  await Promise.all(
    missing.map((t, i) => {
      t.embedding = result.vectors[i]; // keep the in-hand copy current too
      t.embeddingModel = model;
      return store.saveEmbedding(t.ticketId, result.vectors[i], model);
    })
  );
  return { status: 'ok', model };
}

function aiScores(ticket, candidates) {
  return candidates
    .filter((c) => c.embeddingModel === ticket.embeddingModel && c.embedding && c.embedding.length)
    .map((c) => ({ ...summary(c), score: cosineSimilarity(ticket.embedding, c.embedding) }));
}

// Returns the AI result, or null when the AI method can't run (no key,
// API down, timeout...). Never throws. `why` (optional object) receives
// the reason, for display.
async function findAiMatches(ticket, candidates, threshold = aiThreshold(), why = {}) {
  try {
    const ready = await ensureEmbeddings([ticket, ...candidates]);
    if (ready.status !== 'ok') {
      why.status = ready.status;
      why.reason = ready.reason;
      return null;
    }
    return {
      status: 'ok',
      method: 'cosine',
      model: ready.model,
      threshold,
      matches: topMatches(aiScores(ticket, candidates), threshold),
      ranAt: new Date(),
    };
  } catch (err) {
    console.error('AI duplicate detection failed:', err.message);
    why.status = 'error';
    why.reason = err.message;
    return null;
  }
}

// Runs both methods for one ticket against every other ticket and stores
// the results on it. Safe to call on ticket creation: never throws, and
// the baseline result is always produced even when the AI side can't run.
async function detectDuplicates(ticketId) {
  const all = await store.listTickets({}, { withEmbeddings: true });
  const ticket = all.find((t) => t.ticketId === ticketId);
  if (!ticket) return null;
  const candidates = all.filter((t) => t.ticketId !== ticketId);

  const baseline = findBaselineMatches(ticket, candidates);
  const why = {};
  const ai = (await findAiMatches(ticket, candidates, aiThreshold(), why)) || {
    status: why.status || 'skipped',
    reason: why.reason || 'AI method unavailable',
    threshold: aiThreshold(),
    matches: [],
    ranAt: new Date(),
  };

  const duplicates = { ai, baseline, comparedAgainst: candidates.length };
  await store.saveDuplicates(ticketId, duplicates);
  return duplicates;
}

module.exports = {
  detectDuplicates,
  ensureEmbeddings,
  findAiMatches,
  findBaselineMatches,
  baselineScores,
  aiScores,
  aiThreshold,
  baselineThreshold,
  TOP_K,
};
