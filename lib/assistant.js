// Stretch feature 3: self-service help assistant.
//
// Retrieval only, no text generation: the user's question is matched
// against the knowledge-base articles (managed at /kb) - with embeddings when an API
// key is set, keyword Jaccard otherwise - and the best articles are
// returned word for word. It also points the user at their OWN open
// tickets on the same topic (never other people's tickets: those would
// leak other users' data). Because it only returns written articles, it
// can't invent wrong instructions.

const store = require('./store');
const embeddings = require('./embeddings');
const { cosineSimilarity, tokenize, jaccardSimilarity } = require('./similarity');
const { ensureEmbeddings } = require('./duplicates');

const MAX_ARTICLES = 3;
// Minimum score for an article to be shown at all.
const AI_MIN = 0.8;
const AI_OWN_TICKET_MIN = 0.8;
const KEYWORD_MIN = 0.05;

async function ask(question, user) {
  const q = (question || '').trim().slice(0, 500);
  if (!q) return { question: q, method: null, articles: [], ownTickets: [] };

  const kb = await store.listArticles();
  let method = 'keyword';
  let scores = null;
  let questionVector = null;
  if (embeddings.isConfigured()) {
    const result = await embeddings.embedTexts([q, ...kb.map((a) => `${a.title}\n${a.body}`)]);
    if (result.status === 'ok') {
      const [qv, ...av] = result.vectors;
      questionVector = qv;
      scores = av.map((v) => cosineSimilarity(qv, v));
      method = 'ai';
    }
  }
  if (!scores) {
    const qt = tokenize(q);
    scores = kb.map((a) => jaccardSimilarity(qt, tokenize(`${a.title} ${a.body}`)));
  }
  const min = method === 'ai' ? AI_MIN : KEYWORD_MIN;
  const articles = kb
    .map((a, i) => ({ ...a, score: Math.round(scores[i] * 1000) / 1000 }))
    .filter((a) => a.score >= min)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ARTICLES);

  // The user's own unresolved tickets that look related, so they can add
  // to an existing ticket instead of filing a new one.
  const qt = tokenize(q);
  const mine = user
    ? (await store.listTickets({ requesterEmail: user.email }, { withEmbeddings: true })).filter((t) => t.status === 'Open' || t.status === 'In Progress')
    : [];
  const useAi = !!questionVector && mine.length > 0 && (await ensureEmbeddings(mine)).status === 'ok';
  const ownTickets = mine
    .map((t) => ({
      ticketId: t.ticketId,
      title: t.title,
      status: t.status,
      score: useAi ? cosineSimilarity(questionVector, t.embedding) : jaccardSimilarity(qt, tokenize(`${t.title} ${t.description}`)),
    }))
    .filter((t) => t.score >= (useAi ? AI_OWN_TICKET_MIN : 0.1))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  return { question: q, method, articles, ownTickets };
}

module.exports = { ask };
