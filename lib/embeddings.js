// Embeddings client for the AI duplicate-detection method.
//
// Supports two providers, picked from EMBEDDINGS_PROVIDER or, if unset,
// from the shape of LLM_API_KEY ("sk-..." = OpenAI, anything else =
// Google Gemini):
//   gemini -> gemini-embedding-001 (768 dimensions)
//   openai -> text-embedding-3-small (1536 dimensions)
//
// Contract: embedTexts() NEVER throws. With no key configured it returns
// { status: 'skipped' }, and on any API/network failure it returns
// { status: 'error' }, so ticket creation can't be broken by the AI side.
//
// Results are cached on disk (data/.embedding-cache.json, git-ignored),
// keyed by provider + model + text, so restarting the app or re-running
// the evaluation doesn't re-spend API quota on the same tickets.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROVIDERS = {
  gemini: { model: 'gemini-embedding-001', dimensions: 768 },
  openai: { model: 'text-embedding-3-small', dimensions: 1536 },
};
const TIMEOUT_MS = 10000;
const CACHE_FILE = path.join(__dirname, '../data/.embedding-cache.json');

let cache = null;

function config() {
  const apiKey = (process.env.LLM_API_KEY || '').trim();
  if (!apiKey) return null;
  let provider = (process.env.EMBEDDINGS_PROVIDER || '').trim().toLowerCase();
  if (!provider) provider = apiKey.startsWith('sk-') ? 'openai' : 'gemini';
  if (!PROVIDERS[provider]) return null;
  return { provider, apiKey, ...PROVIDERS[provider] };
}

// Short label like "gemini/gemini-embedding-001", stored next to each
// embedding so vectors from different models are never compared.
function modelLabel() {
  const cfg = config();
  return cfg ? `${cfg.provider}/${cfg.model}` : null;
}

function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch (err) {
    console.error('Could not write embedding cache:', err.message);
  }
}

function cacheKey(label, text) {
  return crypto.createHash('sha256').update(`${label}\n${text}`).digest('hex');
}

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && (data.error.message || data.error)) || res.statusText;
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return data;
}

async function callGemini(cfg, texts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:batchEmbedContents`;
  const data = await postJson(url, { 'x-goog-api-key': cfg.apiKey }, {
    requests: texts.map((text) => ({
      model: `models/${cfg.model}`,
      content: { parts: [{ text }] },
      taskType: 'SEMANTIC_SIMILARITY',
      outputDimensionality: cfg.dimensions,
    })),
  });
  return data.embeddings.map((e) => e.values);
}

async function callOpenAI(cfg, texts) {
  const data = await postJson(
    'https://api.openai.com/v1/embeddings',
    { Authorization: `Bearer ${cfg.apiKey}` },
    { model: cfg.model, input: texts }
  );
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// Embeds a list of texts. Returns:
//   { status: 'ok', model, vectors: [[...], ...] }  (same order as texts)
//   { status: 'skipped', reason }                   (no key configured)
//   { status: 'error', reason }                     (API/network failure)
async function embedTexts(texts) {
  const cfg = config();
  if (!cfg) return { status: 'skipped', reason: 'No LLM_API_KEY configured' };
  const label = modelLabel();
  const store = loadCache();
  const vectors = texts.map((t) => store[cacheKey(label, t)] || null);
  const missing = texts.map((t, i) => (vectors[i] ? null : i)).filter((i) => i !== null);

  try {
    // Both APIs accept up to 100 texts per call.
    for (let start = 0; start < missing.length; start += 100) {
      const batch = missing.slice(start, start + 100);
      const batchTexts = batch.map((i) => texts[i]);
      const result = cfg.provider === 'openai'
        ? await callOpenAI(cfg, batchTexts)
        : await callGemini(cfg, batchTexts);
      batch.forEach((i, j) => {
        vectors[i] = result[j];
        store[cacheKey(label, texts[i])] = result[j];
      });
    }
  } catch (err) {
    console.error(`Embeddings call failed (${label}):`, err.message);
    return { status: 'error', reason: err.message };
  }

  if (missing.length) saveCache();
  return { status: 'ok', model: label, vectors };
}

// The text we embed for a ticket - title and description together.
function ticketText(ticket) {
  return `${ticket.title}\n${ticket.description}`;
}

module.exports = { embedTexts, ticketText, modelLabel, isConfigured: () => !!config() };
