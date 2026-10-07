// Hash chain for the audit log, shared by both storage modes.
const crypto = require('crypto');

const GENESIS_HASH = '0'.repeat(64);

function computeHash({ seq, actorEmail, action, detail, createdAt, prevHash }) {
  const payload = JSON.stringify({
    seq,
    actorEmail,
    action,
    detail: normalizeDetail(detail),
    createdAt: new Date(createdAt).toISOString(),
    prevHash,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// MongoDB drops empty objects on save, so {} must be stored as null -
// otherwise the hash (computed on {}) wouldn't match what is read back.
function normalizeDetail(detail) {
  return detail && Object.keys(detail).length ? detail : null;
}

function buildEntry(prev, actorEmail, action, detail) {
  const entry = {
    seq: prev ? prev.seq + 1 : 1,
    actorEmail,
    action,
    detail: normalizeDetail(detail),
    createdAt: new Date(),
    prevHash: prev ? prev.hash : GENESIS_HASH,
  };
  entry.hash = computeHash(entry);
  return entry;
}

// Walks the chain oldest-first. Returns { ok: true } or the first broken
// entry, so a manager can see exactly where tampering happened.
function verifyChain(entriesOldestFirst) {
  let prevHash = GENESIS_HASH;
  for (const e of entriesOldestFirst) {
    if (e.prevHash !== prevHash || computeHash(e) !== e.hash) {
      return { ok: false, brokenAt: e.seq };
    }
    prevHash = e.hash;
  }
  return { ok: true, count: entriesOldestFirst.length };
}

module.exports = { buildEntry, verifyChain, GENESIS_HASH };
