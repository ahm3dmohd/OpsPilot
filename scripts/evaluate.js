// AI-vs-baseline evaluation of duplicate detection. Run with:
//   npm run evaluate
// Prints the headline numbers and writes the full results (threshold
// sweeps, hardest cases, held-out table, caveats) to
// docs/evaluation-results.md. The same numbers are on the manager-only
// /evaluation page. See lib/evaluation.js for the method.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runEvaluation, toMarkdown } = require('../lib/evaluation');

const pct = (x) => `${(x * 100).toFixed(0)}%`;

async function main() {
  const r = await runEvaluation();
  const file = path.join(__dirname, '../docs/evaluation-results.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, toMarkdown(r));

  const seed = (s) => `P ${pct(s.at.precision)} R ${pct(s.at.recall)} F1 ${s.at.f1.toFixed(2)} (best F1 ${s.best.f1.toFixed(2)} @${s.best.threshold})`;
  const held = (h) => `P ${pct(h.at.precision)} R ${pct(h.at.recall)} F1 ${h.at.f1.toFixed(2)}, top match right ${h.topRight}/${h.withCluster}, false alarms ${h.falseAlarms}/${h.noCluster}`;
  console.log(`Baseline  @${r.seed.baseline.threshold}: ${seed(r.seed.baseline)}`);
  if (r.seed.ai) console.log(`AI        @${r.seed.ai.threshold}: ${seed(r.seed.ai)}`);
  else console.log(`AI        not evaluated: ${r.aiStatus.reason}`);
  console.log(`Baseline held-out: ${held(r.held.baseline)}`);
  if (r.held.ai) console.log(`AI       held-out: ${held(r.held.ai)}`);
  console.log(`Full results written to ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
