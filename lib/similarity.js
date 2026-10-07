// Hand-written similarity maths, no libraries: cosine similarity for the
// AI method's embedding vectors, and tokenizing + Jaccard similarity for
// the keyword baseline.

function cosineSimilarity(a, b) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Common English words that carry no meaning about the problem itself,
// plus helpdesk filler ("please", "help", "issue") that appears in almost
// every ticket and would make unrelated tickets look similar.
const STOPWORDS = new Set(`
a about above after again against all also am an and any are as at be because been before being below
between both but by can cannot could did do does doing down during each few for from further had has
have having he her here hers herself him himself his how i if in into is it its itself just let me
more most my myself no nor not now of off on once only or other our ours ourselves out over own same
she should so some such than that the their theirs them themselves then there these they this those
through to too under until up very was we were what when where which while who whom why will with
would you your yours yourself yourselves
im ive dont doesnt didnt cant wont isnt its thats theres
get gets got getting keep keeps kept still since today morning now really every again etc
please thanks thank hi hello help issue problem need needs needed want trying tried try
`.trim().split(/\s+/));

// Very light suffix stripping so "drops", "dropping" and "dropped" all
// count as the same keyword. Deliberately crude (not a full Porter
// stemmer) - it only needs to stop the baseline being a strawman.
function stem(word) {
  if (word.length <= 4) return word;
  let w = word;
  if (w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);
  // "boxes"/"patches" lose "es", but "licenses"/"minutes" only lose "s".
  else if (/(ss|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  // "dropping" -> "dropp" -> "drop" (only when a suffix was removed, so
  // "address" and "full" are left alone)
  if (w !== word && w.length > 3 && w[w.length - 1] === w[w.length - 2] && !/(ss|ll)$/.test(w)) w = w.slice(0, -1);
  return w;
}

// lowercase -> strip punctuation -> split on whitespace -> drop stopwords
// and 1-character tokens -> stem -> unique set.
function tokenize(text) {
  const words = (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
  return new Set(words);
}

// |A ∩ B| / |A ∪ B|, between 0 (nothing shared) and 1 (identical sets).
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) if (setB.has(word)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

module.exports = { cosineSimilarity, tokenize, stem, jaccardSimilarity, STOPWORDS };
