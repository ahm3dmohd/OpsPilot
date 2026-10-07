// AI-vs-baseline evaluation of duplicate detection against known answers.
// Shared by `npm run evaluate` (scripts/evaluate.js, writes a markdown
// report) and the manager-only /evaluation page.
//
// SEED SET: every ticket in data/tickets.json carries a hand-assigned
// `cluster` label (e.g. "vpn"), or null for standalone tickets. Two tickets
// are a TRUE duplicate pair when they share a cluster. Each method scores
// all 190 pairs; a pair is PREDICTED duplicate when its score is at or
// above the method's threshold. The thresholds were tuned on this set, so
// its numbers are optimistic.
//
// HELD-OUT SET: data/eval-holdout.json holds 12 tickets never used for
// tuning. Each is run as a "new ticket" against the 20 seed tickets at the
// FIXED configured thresholds - the fairer number to quote.
//
// Uses the original seed data (not live tickets), so results don't change
// as people use the app. Needs LLM_API_KEY for the AI method; embeddings
// are cached, so re-runs cost nothing. Never throws for a missing key -
// the AI side is reported as not evaluated.

const fs = require('fs');
const path = require('path');
const { seedTickets } = require('./seedData');
const embeddings = require('./embeddings');
const { cosineSimilarity, tokenize, jaccardSimilarity } = require('./similarity');
const { aiThreshold, baselineThreshold } = require('./duplicates');

function loadJson(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '../data', file), 'utf8'));
}

function metrics(pairs, threshold) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  pairs.forEach((p) => {
    const predicted = p.score >= threshold;
    if (predicted && p.truth) tp += 1;
    else if (predicted && !p.truth) fp += 1;
    else if (!predicted && p.truth) fn += 1;
  });
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { threshold, tp, fp, fn, precision, recall, f1 };
}

function sweep(pairs, [from, to, step]) {
  const rows = [];
  for (let t = from; t <= to + 1e-9; t += step) rows.push(metrics(pairs, Math.round(t * 100) / 100));
  return rows;
}

// Scores for one method on the seed set: headline metrics at the
// configured threshold, a threshold sweep, and the hardest cases.
function seedResult(name, pairs, threshold, range, titleOf) {
  const rows = sweep(pairs, range);
  const describe = (p) => ({ ...p, aTitle: titleOf(p.a), bTitle: titleOf(p.b) });
  return {
    name,
    threshold,
    at: metrics(pairs, threshold),
    best: rows.reduce((x, y) => (y.f1 > x.f1 ? y : x)),
    sweep: rows,
    closestFalse: pairs.filter((p) => !p.truth).sort((x, y) => y.score - x.score).slice(0, 5).map(describe),
    weakestTrue: pairs.filter((p) => p.truth).sort((x, y) => x.score - y.score).slice(0, 5).map(describe),
  };
}

async function runEvaluation() {
  const raw = loadJson('tickets.json');
  const holdout = loadJson('eval-holdout.json');
  const clusterOf = Object.fromEntries(raw.map((t) => [t.ticketId, t.cluster]));
  const tickets = seedTickets();
  const titleOf = (id) => tickets.find((t) => t.ticketId === id).title;

  function allPairs(scoreFn) {
    const pairs = [];
    for (let i = 0; i < tickets.length; i++) {
      for (let j = i + 1; j < tickets.length; j++) {
        const a = tickets[i].ticketId;
        const b = tickets[j].ticketId;
        pairs.push({ a, b, truth: !!clusterOf[a] && clusterOf[a] === clusterOf[b], score: scoreFn(i, j) });
      }
    }
    return pairs;
  }

  // Each held-out ticket vs. every seed ticket at a fixed threshold.
  function holdoutResult(name, threshold, scoreFn) {
    const pairs = [];
    let topRight = 0;
    let withCluster = 0;
    let falseAlarms = 0;
    let noCluster = 0;
    const perTicket = holdout.map((h, i) => {
      const scored = tickets.map((t, j) => ({
        ticketId: t.ticketId,
        score: scoreFn(i, j),
        truth: !!h.expectedCluster && clusterOf[t.ticketId] === h.expectedCluster,
      }));
      pairs.push(...scored);
      const flagged = scored.filter((s) => s.score >= threshold).sort((a, b) => b.score - a.score);
      if (h.expectedCluster) {
        withCluster += 1;
        if (flagged[0] && flagged[0].truth) topRight += 1;
      } else {
        noCluster += 1;
        if (flagged.length) falseAlarms += 1;
      }
      return flagged.slice(0, 3);
    });
    return { name, threshold, at: metrics(pairs, threshold), topRight, withCluster, falseAlarms, noCluster, perTicket };
  }

  const tokens = tickets.map((t) => tokenize(`${t.title} ${t.description}`));
  const holdTokens = holdout.map((h) => tokenize(`${h.title} ${h.description}`));
  const truePairs = allPairs(() => 0).filter((p) => p.truth).length;

  const result = {
    ranAt: new Date(),
    seedCount: tickets.length,
    pairCount: (tickets.length * (tickets.length - 1)) / 2,
    truePairs,
    holdout: holdout.map((h) => ({ title: h.title, expectedCluster: h.expectedCluster })),
    seed: {
      baseline: seedResult('Baseline: keyword Jaccard', allPairs((i, j) => jaccardSimilarity(tokens[i], tokens[j])), baselineThreshold(), [0.05, 0.4, 0.05], titleOf),
      ai: null,
    },
    held: {
      baseline: holdoutResult('Baseline', baselineThreshold(), (i, j) => jaccardSimilarity(holdTokens[i], tokens[j])),
      ai: null,
    },
    aiStatus: null,
  };

  const texts = [...tickets.map(embeddings.ticketText), ...holdout.map(embeddings.ticketText)];
  const embedded = await embeddings.embedTexts(texts);
  if (embedded.status === 'ok') {
    const seedVecs = embedded.vectors.slice(0, tickets.length);
    const holdVecs = embedded.vectors.slice(tickets.length);
    result.aiStatus = { status: 'ok', model: embedded.model };
    result.seed.ai = seedResult(`AI: embeddings + cosine (${embedded.model})`, allPairs((i, j) => cosineSimilarity(seedVecs[i], seedVecs[j])), aiThreshold(), [0.6, 0.94, 0.02], titleOf);
    result.held.ai = holdoutResult('AI', aiThreshold(), (i, j) => cosineSimilarity(holdVecs[i], seedVecs[j]));
  } else {
    result.aiStatus = { status: embedded.status, reason: embedded.reason };
  }
  return result;
}

const pct = (x) => `${(x * 100).toFixed(0)}%`;

// Markdown version of the results (written to docs/evaluation-results.md).
function toMarkdown(r) {
  const out = [
    '# Duplicate detection: AI vs. baseline',
    '',
    `Generated by \`npm run evaluate\` on ${r.ranAt.toISOString().slice(0, 10)}.`,
    `${r.seedCount} seed tickets, ${r.pairCount} pairs, ${r.truePairs} true duplicate pairs (same \`cluster\` label in data/tickets.json).`,
    '',
  ];
  const row = (m) => `| ${m.threshold.toFixed(2)} | ${m.tp} | ${m.fp} | ${m.fn} | ${pct(m.precision)} | ${pct(m.recall)} | ${m.f1.toFixed(2)} |`;
  [r.seed.baseline, r.seed.ai].forEach((s) => {
    if (!s) {
      out.push('## AI: embeddings + cosine', '', `Not evaluated: ${r.aiStatus.reason}.`, '');
      return;
    }
    out.push(`## ${s.name}`, '');
    out.push(`At the configured threshold **${s.threshold}**: precision ${pct(s.at.precision)}, recall ${pct(s.at.recall)}, F1 ${s.at.f1.toFixed(2)} (TP ${s.at.tp}, FP ${s.at.fp}, FN ${s.at.fn}).`);
    out.push(`Best F1 on this set: **${s.best.f1.toFixed(2)}** at threshold ${s.best.threshold}.`, '');
    out.push('| Threshold | TP | FP | FN | Precision | Recall | F1 |', '|---|---|---|---|---|---|---|');
    s.sweep.forEach((m) => out.push(row(m)));
    out.push('', '**Highest-scoring NON-duplicate pairs** (closest to being false positives):', '');
    s.closestFalse.forEach((p) => out.push(`- ${p.score.toFixed(3)} - ${p.a} "${p.aTitle}" vs ${p.b} "${p.bTitle}"`));
    out.push('', '**Lowest-scoring TRUE duplicate pairs** (hardest to catch):', '');
    s.weakestTrue.forEach((p) => out.push(`- ${p.score.toFixed(3)} - ${p.a} "${p.aTitle}" vs ${p.b} "${p.bTitle}"`));
    out.push('');
  });

  out.push('## Held-out test (fixed thresholds, no tuning)', '');
  out.push(`${r.holdout.length} new tickets, each compared against the ${r.seedCount} seed tickets (${r.holdout.length * r.seedCount} pairs). "Top match right" = the highest-scoring flagged match is in the expected cluster; "false alarm" = a ticket with no real duplicate got at least one match flagged.`, '');
  const held = [r.held.baseline, r.held.ai].filter(Boolean);
  held.forEach((h) => out.push(`- **${h.name}** @ ${h.threshold}: precision ${pct(h.at.precision)}, recall ${pct(h.at.recall)}, F1 ${h.at.f1.toFixed(2)}; top match right ${h.topRight}/${h.withCluster}; false alarms ${h.falseAlarms}/${h.noCluster}`));
  out.push('', `| Held-out ticket | Expected | ${held.map((h) => h.name).join(' | ')} |`, `|---|---|${held.map(() => '---|').join('')}`);
  const cell = (flagged) => (flagged.length ? flagged.map((f) => `${f.ticketId}${f.truth ? '' : ' (wrong)'} ${f.score.toFixed(2)}`).join(', ') : 'no matches');
  r.holdout.forEach((h, i) => out.push(`| ${h.title} | ${h.expectedCluster || '(none)'} | ${held.map((x) => cell(x.perTicket[i])).join(' | ')} |`));
  out.push(
    '',
    '## Caveats',
    '',
    '- 20 tickets is a small, hand-made set. Treat these numbers as a sanity check of the approach, not as a general accuracy claim.',
    '- The thresholds were tuned on the seed set, so its "best F1" figures are optimistic. Quote the held-out numbers.',
    '- The held-out tickets were written by the same author as the seed set; tickets written by someone else would be a stronger test.',
    '- "Duplicate" here means same underlying issue. T-1019 (office wifi dropping) is deliberately close to the VPN cluster but labelled standalone: it is a hard negative.',
    ''
  );
  return out.join('\n');
}

module.exports = { runEvaluation, toMarkdown, metrics };
