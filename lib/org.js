// Org structure edits (admins only - routes check that): a user's
// department and line manager, and each department's head. Everything is
// validated here on the server; each function returns { ... } on success
// or { reason } for the page to explain.
const store = require('./store');

const CODE = /^[A-Z][A-Z0-9-]{0,11}$/;

// Would making `managerEmail` the manager of `email` create a loop
// (A manages B manages A)? Walks up from the proposed manager.
function createsLoop(users, email, managerEmail) {
  const byEmail = new Map(users.map((u) => [u.email, u]));
  const seen = new Set();
  let current = managerEmail;
  while (current && !seen.has(current)) {
    if (current === email) return true;
    seen.add(current);
    current = (byEmail.get(current) || {}).managerEmail || null;
  }
  return false;
}

async function setUserOrg(email, { department, managerEmail }) {
  const user = await store.findUserByEmail(String(email || ''));
  if (!user) return { reason: 'not_found' };
  const dept = String(department || '');
  const mgr = String(managerEmail || '').toLowerCase().trim();
  if (dept && !(await store.getDepartment(dept))) return { reason: 'bad_department' };
  if (mgr) {
    if (mgr === user.email) return { reason: 'self_manager' };
    if (!(await store.findUserByEmail(mgr))) return { reason: 'bad_manager' };
    if (createsLoop(await store.listUsers(), user.email, mgr)) return { reason: 'manager_loop' };
  }
  const before = { department: user.department || null, managerEmail: user.managerEmail || null };
  const updated = await store.updateUserOrg(user.email, { department: dept || null, managerEmail: mgr || null });
  return { user: updated, before };
}

async function addDepartment({ code, name }) {
  const c = String(code || '').trim().toUpperCase();
  const n = String(name || '').trim().slice(0, 60);
  if (!CODE.test(c) || n.length < 2) return { reason: 'bad_input' };
  const dept = await store.createDepartment({ code: c, name: n });
  return dept ? { dept } : { reason: 'code_taken' };
}

async function setHead(code, headEmail) {
  const dept = await store.getDepartment(String(code || ''));
  if (!dept) return { reason: 'not_found' };
  const email = String(headEmail || '').toLowerCase().trim();
  if (email && !(await store.findUserByEmail(email))) return { reason: 'bad_head' };
  const updated = await store.setDepartmentHead(dept.code, email || null);
  return { dept: updated, before: dept.headEmail || null };
}

module.exports = { setUserOrg, addDepartment, setHead, createsLoop, CODE };
