// Admin-changeable settings, cached in memory so hot paths (duplicate
// detection) can read them synchronously. load() runs at startup; set()
// and clear() write through to the store and the cache together.
const store = require('./store');

let cache = {};

async function load() {
  cache = {};
  (await store.listSettings()).forEach((s) => (cache[s.key] = s));
}

function get(key) {
  return cache[key] ? cache[key].value : undefined;
}

function info(key) {
  return cache[key] || null; // { key, value, updatedByEmail, updatedAt }
}

async function set(key, value, actor) {
  cache[key] = await store.saveSetting(key, value, actor.email);
}

async function clear(key) {
  await store.deleteSetting(key);
  delete cache[key];
}

module.exports = { load, get, info, set, clear };
