// End-to-end smoke test: starts the real server (mock-data mode by default) on a
// spare port and drives it over HTTP like a browser would (cookies,
// redirects, form posts). Checks the main workflow, the duplicate
// detection results, and every role's access boundaries (403s).
//
//   npm test                      (uses LLM_API_KEY from .env if set)
//   LLM_API_KEY= npm test         (forces the "no AI key" fallback path)
//
// To test real-DB mode instead, point TEST_MONGODB_URI at a THROWAWAY
// database - it is wiped and re-seeded first:
//   TEST_MONGODB_URI=mongodb://localhost:27017/opspilot_test npm test

require('dotenv').config();
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
const PASSWORD = 'password123';
const NOTE_SECRET = `Internal: line manager approved the replacement (${Date.now()})`;

let failures = 0;
let passes = 0;
function check(name, condition, extra = '') {
  if (condition) {
    passes += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

// Minimal browser: one cookie jar per user, no automatic redirects so we
// can assert on status codes and Location headers.
function client() {
  let cookie = '';
  async function request(method, url, form) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    let body;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(BASE + url, { method, headers, body, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location') || '', text };
  }
  return {
    get: (url) => request('GET', url),
    post: (url, form = {}) => request('POST', url, form),
    async json(url, data) {
      const res = await fetch(BASE + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(data),
      });
      return { status: res.status, body: res.status === 200 ? await res.json() : null };
    },
    async login(email) {
      return request('POST', '/login', { email, password: PASSWORD });
    },
  };
}

async function waitForServer(proc) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Server did not start:\n${output}`)), 15000);
    proc.stdout.on('data', (d) => {
      output += d;
      if (output.includes('OpsPilot running')) {
        if (process.env.TEST_MONGODB_URI && !output.includes('MongoDB connected')) {
          clearTimeout(timer);
          return reject(new Error(`TEST_MONGODB_URI set but the server fell back to mock mode:\n${output}`));
        }
        clearTimeout(timer);
        resolve();
      }
    });
    proc.stderr.on('data', (d) => (output += d));
    proc.on('exit', (code) => reject(new Error(`Server exited (${code}):\n${output}`)));
  });
}

// Logic that can't be reached over HTTP on its own, run against a separate
// in-memory store inside this process (the server above is untouched).
async function unitChecks() {
  console.log('\nUnit checks (in-process mock store)');
  const store = require('../lib/store');
  const { changeRole } = require('../lib/roles');
  store.useMockData();
  // Only an admin can reach changeRole through the app, and they can't
  // change themselves, so "last admin" only happens when two admins demote
  // each other at once. Call it directly with another actor to cover it.
  const r = await changeRole({ email: 'manager@opspilot.test' }, 'admin@opspilot.test', 'agent');
  check('the last admin cannot be demoted', r.reason === 'last_admin');
  check('...and is still an admin', (await store.findUserByEmail('admin@opspilot.test')).role === 'admin');

  const { PERMISSIONS, can } = require('../lib/permissions');
  const { requirePermission } = require('../middleware/auth');
  const { ROLES } = require('../lib/constants');
  check('every role has a permission list', ROLES.every((role) => Array.isArray(PERMISSIONS[role])));
  let threw = false;
  try { can({ role: 'agent' }, 'tickets.claim'); } catch (e) { threw = true; }
  check('a misspelled permission throws instead of silently denying', threw);
  threw = false;
  try { requirePermission('reprot.export'); } catch (e) { threw = true; }
  check('...including when a route is defined (server would not start)', threw);
  check('admin has every manager permission, spelled out', PERMISSIONS.manager.every((p) => PERMISSIONS.admin.includes(p)));
  check('end users can only create tickets', PERMISSIONS.end_user.join() === 'ticket.create');
  check('only agents claim; only managers/admins assign', can({ role: 'agent' }, 'ticket.claim') && !can({ role: 'manager' }, 'ticket.claim') && !can({ role: 'agent' }, 'ticket.assign') && can({ role: 'admin' }, 'ticket.assign'));
  check('nobody logged out can do anything', !can(null, 'ticket.create'));
}

async function main() {
  const dbUri = process.env.TEST_MONGODB_URI || '';
  if (dbUri) {
    console.log(`Re-seeding test database ${dbUri.replace(/\/\/[^@]*@/, '//***@')} ...`);
    const seed = spawnSync(process.execPath, [path.join(__dirname, 'seed.js')], {
      env: { ...process.env, MONGODB_URI: dbUri },
      stdio: 'inherit',
    });
    if (seed.status !== 0) throw new Error('Seeding the test database failed');
  }
  const env = { ...process.env, PORT: String(PORT), MONGODB_URI: dbUri };
  const proc = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitForServer(proc);
    const aiOn = !!(process.env.LLM_API_KEY || '').trim();
    console.log(`Server up on ${BASE} (${dbUri ? 'MongoDB' : 'mock'} mode, AI key ${aiOn ? 'set' : 'NOT set'})\n`);

    const anon = client();
    const endUser = client();
    const agent = client();
    const agent2 = client();
    const manager = client();
    const admin = client();

    console.log('Styles');
    let r = await anon.get('/css/app.css');
    const neededClasses = ['pill-open', 'pill-in-progress', 'pill-resolved', 'pill-closed', 'pill-low', 'pill-medium', 'pill-high', 'pill-urgent',
      'pill-sla-breached', 'pill-sla-at_risk', 'pill-sla-ok', 'pill-sla-met', 'strip-low', 'strip-medium', 'strip-high', 'strip-urgent'];
    const missingCss = neededClasses.filter((c) => !r.text.includes(`.${c}`));
    check('compiled CSS includes the data-driven classes (run npm run build:css if not)', r.status === 200 && missingCss.length === 0, missingCss.join(', '));
    r = await anon.get('/fonts/ibm-plex-sans-latin-400-normal.woff2');
    check('fonts are served locally', r.status === 200);

    console.log('\nAuth');
    r = await anon.get('/dashboard');
    check('logged-out user is sent to /login', r.status === 302 && r.location === '/login');
    r = await anon.post('/login', { email: 'agent@opspilot.test', password: 'wrong' });
    check('wrong password is rejected (401)', r.status === 401);
    const lead = client(); // Khalid: Erin's line manager (Finance)
    const finhead = client(); // Layla: head of Finance, Khalid's manager
    for (const [c, email] of [[endUser, 'enduser'], [agent, 'agent'], [agent2, 'agent2'], [manager, 'manager'], [admin, 'admin'], [lead, 'lead'], [finhead, 'finhead']]) {
      r = await c.login(`${email}@opspilot.test`);
      check(`${email} can log in`, r.status === 302 && r.location === '/dashboard');
    }
    r = await anon.post('/register', { name: 'Sneaky', email: 'sneaky@example.com', password: 'longenough1', role: 'manager' });
    check('register ignores a posted role=manager', r.status === 302);
    r = await anon.get('/audit');
    check('...and the new account is NOT a manager (403 on /audit)', r.status === 403);
    r = await anon.get('/dashboard');
    check('...it gets the end-user dashboard', r.text.includes('My tickets'));

    console.log('\nDashboards');
    r = await endUser.get('/dashboard');
    check('end user sees own tickets', r.status === 200 && r.text.includes('T-1003') && !r.text.includes('T-1001'));
    r = await agent.get('/dashboard');
    check('agent sees open queue', r.status === 200 && r.text.includes('Open queue') && r.text.includes('T-1001'));
    r = await manager.get('/dashboard');
    check('manager sees overview + SLA watch', r.status === 200 && r.text.includes('SLA watch') && r.text.includes('Agent workload'));

    console.log('\nRole boundaries (each should be 403)');
    const forbidden = [
      [endUser, 'GET', '/audit', 'end user -> audit log'],
      [endUser, 'GET', '/tickets/T-1001', "end user -> someone else's ticket"],
      [endUser, 'POST', '/tickets/T-1001/comment', "end user -> comment on someone else's ticket"],
      [endUser, 'POST', '/tickets/T-1003/claim', 'end user -> claim'],
      [endUser, 'POST', '/tickets/T-1003/status', 'end user -> change status'],
      [endUser, 'POST', '/tickets/T-1003/duplicates', 'end user -> re-run duplicates'],
      [endUser, 'POST', '/tickets/T-1003/assign', 'end user -> assign'],
      [endUser, 'POST', '/tickets/T-1003/notes', 'end user -> internal note on own ticket'],
      [endUser, 'POST', '/tickets/T-1001/notes', "end user -> internal note on someone else's ticket"],
      [agent, 'GET', '/tickets/new', 'agent -> new ticket form'],
      [agent, 'POST', '/tickets', 'agent -> create ticket'],
      [agent, 'GET', '/audit', 'agent -> audit log'],
      [agent, 'POST', '/tickets/T-1001/assign', 'agent -> assign'],
      [manager, 'GET', '/tickets/new', 'manager -> new ticket form (by design)'],
      [manager, 'POST', '/tickets', 'manager -> create ticket'],
      [manager, 'POST', '/tickets/T-1001/claim', 'manager -> claim'],
      [endUser, 'GET', '/kb/new', 'end user -> new KB article form'],
      [endUser, 'POST', '/kb', 'end user -> create KB article'],
      [endUser, 'POST', '/kb/KB-01', 'end user -> edit KB article'],
      [agent, 'POST', '/kb/KB-01/delete', 'agent -> delete KB article'],
      [endUser, 'GET', '/reports/tickets.csv', 'end user -> CSV export'],
      [agent, 'GET', '/reports/tickets.csv', 'agent -> CSV export'],
      [endUser, 'GET', '/evaluation', 'end user -> evaluation page'],
      [endUser, 'GET', '/tickets', 'end user -> filtered ticket list'],
      [endUser, 'GET', '/tickets?status=Open', 'end user -> filtered ticket list with filters'],
      [agent, 'GET', '/evaluation', 'agent -> evaluation page'],
      [endUser, 'POST', '/tickets/T-1003/duplicates/T-1001/confirm', 'end user -> confirm duplicate'],
      [endUser, 'POST', '/tickets/T-1003/duplicates/T-1001/reject', 'end user -> reject duplicate'],
      [endUser, 'GET', '/admin/duplicate-stats', 'end user -> duplicate stats'],
      [agent, 'GET', '/admin/duplicate-stats', 'agent -> duplicate stats'],
      [agent, 'GET', '/admin/duplicate-stats.csv', 'agent -> duplicate decisions CSV'],
      [endUser, 'GET', '/admin/users', 'end user -> user management'],
      [agent, 'GET', '/admin/users', 'agent -> user management'],
      [manager, 'GET', '/admin/users', 'manager -> user management'],
      [manager, 'POST', '/admin/users/role', 'manager -> change a role'],
      [agent, 'POST', '/admin/users/role', 'agent -> change a role'],
      [manager, 'POST', '/admin/users/org', 'manager -> change department/line manager'],
      [manager, 'GET', '/admin/departments', 'manager -> departments page'],
      [manager, 'POST', '/admin/departments', 'manager -> add a department'],
      [agent, 'POST', '/admin/departments/IT/head', 'agent -> set department head'],
      [endUser, 'POST', '/tickets/T-1003/department', 'end user -> re-route ticket'],
      [manager, 'GET', '/admin/approvals', 'manager -> open approvals (admin only)'],
      [agent, 'POST', '/admin/approvals/1/reassign', 'agent -> reassign an approval'],
      [lead, 'GET', '/tickets/T-1001', "line manager -> a ticket they don't approve"],
      [endUser, 'GET', '/canned', 'end user -> canned responses'],
      [endUser, 'POST', '/canned', 'end user -> create canned response'],
      [endUser, 'GET', '/canned/1/edit', 'end user -> edit canned response form'],
      [endUser, 'POST', '/canned/1', 'end user -> edit canned response'],
      [agent, 'POST', '/canned/1/delete', 'agent -> delete canned response'],
    ];
    for (const [c, method, url, label] of forbidden) {
      r = method === 'GET' ? await c.get(url) : await c.post(url, { body: 'x', status: 'Closed', title: 'x', description: 'x' });
      check(label, r.status === 403, `(got ${r.status})`);
    }

    console.log('\nEnd user creates a ticket');
    r = await endUser.post('/tickets/new/suggest', { type: 'incident', title: 'VPN connection keeps dropping', description: 'My VPN disconnects every few minutes when working from home' });
    check('suggest returns the form with a suggested category', r.status === 200 && r.text.includes('Suggested: <strong>Network</strong>'));
    check('suggest shows a help article before filing', r.text.includes('VPN keeps disconnecting'));
    r = await endUser.post('/tickets', {
      type: 'incident',
      department: 'IT',
      title: 'VPN connection keeps dropping',
      // Run tag makes the text unique, so the embeddings API is really
      // called (not served from data/.embedding-cache.json).
      description: `My VPN disconnects every few minutes when working from home, have to reconnect each time (run ${Date.now()})`,
      category: 'Network',
      priority: 'High',
      suggestedCategory: 'Network',
      suggestionMethod: aiOn ? 'ai' : 'keyword',
    });
    const newId = (r.location.match(/T-\d+/) || [])[0];
    check('ticket created and redirected to it', r.status === 302 && !!newId, r.location);
    r = await endUser.get(`/tickets/${newId}`);
    check('requester can view it', r.status === 200);
    check('requester does NOT see the duplicates panel', !r.text.includes('Possible duplicates'));
    r = await endUser.post('/tickets', { type: 'incident', department: 'IT', title: '', description: '' });
    check('empty ticket is rejected (400)', r.status === 400);
    check('...with a message next to each missing field', r.text.includes('id="err-title"') && r.text.includes('id="err-description"') && r.text.includes('aria-invalid="true"'));

    console.log('\nTicket type: incident vs service request');
    r = await endUser.get('/tickets/new');
    check('new ticket starts with the type choice', r.status === 200 && r.text.includes('data-choose="incident"') && r.text.includes('data-choose="service_request"') && !r.text.includes('name="title"'));
    r = await endUser.get('/tickets/new?type=incident');
    check('incident form: problem wording, department picker, no justification', r.text.includes('Report a problem') && r.text.includes('name="department"') && !r.text.includes('name="justification"'));
    r = await endUser.get('/tickets/new?type=service_request');
    check('service request form: request wording, justification and needed-by', r.text.includes('Request something') && r.text.includes('name="justification"') && r.text.includes('name="neededBy"'));
    r = await endUser.post('/tickets', { title: 'No type', description: 'x', department: 'IT' });
    check('a ticket without a type is refused (400) and sent back to the choice', r.status === 400 && r.text.includes('data-choose="incident"'));
    r = await endUser.post('/tickets', { type: 'service_request', department: 'IT', title: 'Need Power BI', description: 'Power BI Pro licence' });
    check('service request without a justification is refused (400)', r.status === 400 && r.text.includes('id="err-justification"'));
    r = await endUser.post('/tickets', { type: 'incident', department: 'NOPE', title: 'Bad dept', description: 'x' });
    check('unknown department is refused (400)', r.status === 400 && r.text.includes('id="err-department"'));
    r = await endUser.post('/tickets', { type: 'service_request', department: 'IT', title: 'Old date', description: 'x', justification: 'y', neededBy: '2001-01-01' });
    check('a needed-by date in the past is refused (400)', r.status === 400 && r.text.includes('id="err-neededBy"'));
    r = await endUser.post('/tickets/new/suggest', { type: 'service_request', title: 'Need a second monitor', description: 'A second monitor for my desk' });
    check('suggest keeps the service-request form and shows no quick fixes', r.status === 200 && r.text.includes('name="justification"') && !r.text.includes('This might fix it'));
    r = await endUser.post('/tickets', {
      type: 'service_request', department: 'FAC', title: 'Standing desk for my office', description: 'An electric standing desk for room 2.14',
      justification: 'Doctor recommended <standing> for back pain', neededBy: '2099-12-31', category: 'Hardware', priority: 'Low',
    });
    const srId = (r.location.match(/T-\d+/) || [])[0];
    check('service request created', r.status === 302 && !!srId, r.location);
    r = await endUser.get(`/tickets/${srId}`);
    check('ticket page shows type badge, department and the justification (escaped)',
      r.text.includes('data-type-pill="service_request"') && r.text.includes('data-department="FAC"') && r.text.includes('Doctor recommended &lt;standing&gt;') && r.text.includes('Needed by'));
    r = await manager.get('/tickets?type=service_request');
    check('type filter lists service requests only, with a chip', r.text.includes(`data-ticket="${srId}"`) && r.text.includes('Type: Service request') && !r.text.includes('data-type-pill="incident"'));
    r = await manager.get('/tickets?type=incident');
    check('...and incidents only', !r.text.includes(`data-ticket="${srId}"`) && r.text.includes('data-type-pill="incident"'));
    r = await endUser.get('/dashboard');
    check("requester's own list shows the type badge", r.text.includes('data-type-pill="service_request"'));
    r = await manager.get('/reports/tickets.csv?type=service_request');
    check('CSV has a type column', r.text.includes('"type"') && r.text.includes('"service_request"'));

    console.log('\nDuplicate detection (agent view)');
    r = await agent.get(`/tickets/${newId}`);
    check('agent sees the duplicates panel', r.text.includes('Possible duplicates'));
    check('baseline found VPN tickets', /Baseline[\s\S]*T-100[1-4]/.test(r.text));
    if (aiOn) {
      check('AI method ran and found VPN tickets', /AI \(embeddings[\s\S]*T-100[1-4][\s\S]*Baseline/.test(r.text));
    } else {
      check('AI method shows as skipped, not an error page', r.status === 200 && r.text.includes('Skipped: No LLM_API_KEY configured'));
    }
    r = await agent.get('/dashboard');
    check('agent queue shows a duplicate badge', r.text.includes('Possible duplicate: AI'));
    r = await agent.get(`/tickets/${newId}`);
    const kwMatch = (/data-method="baseline"[\s\S]*?data-dup-match="(T-\d+)"/.exec(r.text) || [])[1];
    check('each suggestion shows a labelled score bar against the threshold', /Keyword overlap<\/span>\s*<span class="score-bar"/.test(r.text) && r.text.includes('class="score-threshold"'));
    check('...and a plain-language reason with percentages', /Suggested because keyword overlap \(\d+%\) (is above|reaches) the threshold \(10%\)\./.test(r.text), kwMatch);
    check('the threshold each method used is shown', r.text.includes('data-threshold="0.1"'));
    if (aiOn) {
      check('AI vs baseline: summary of what each found', r.text.includes('data-dup-compare') && r.text.includes('agree-tag-both') && /Suggested because meaning similarity \(\d+%\)/.test(r.text));
    } else {
      check('without AI the panel says only the baseline ran', r.text.includes("The AI method didn't run on this ticket"));
    }

    console.log('\nWorkflow');
    r = await agent.post(`/tickets/${newId}/status`, { status: 'Closed' });
    check('Open -> Closed is refused', r.location.includes('msg=bad_transition'));
    r = await agent.post(`/tickets/${newId}/claim`);
    check('agent claims the ticket', r.status === 302 && !r.location.includes('msg='));
    r = await agent2.post(`/tickets/${newId}/claim`);
    check('second agent cannot steal it', r.location.includes('msg=already_claimed'));
    r = await agent.get(`/tickets/${newId}`);
    check('ticket is now In Progress and assigned', r.text.includes('In Progress') && r.text.includes('data-assignee="Adel Haddad"'));
    r = await agent.post(`/tickets/${newId}/comment`, { body: 'Looking into it - can you try a wired connection?' });
    check('agent comments', r.status === 302);
    r = await endUser.post(`/tickets/${newId}/comment`, { body: 'Wired is the same.' });
    check('requester replies on own ticket', r.status === 302);

    console.log('\nInternal notes');
    r = await agent.post(`/tickets/${newId}/notes`, { body: NOTE_SECRET });
    check('agent adds an internal note', r.status === 302 && r.location.endsWith('#notes'));
    r = await manager.post(`/tickets/${newId}/notes`, { body: 'Manager note <b>bold?</b>' });
    check('manager adds an internal note', r.status === 302);
    r = await agent.post(`/tickets/${newId}/notes`, { body: '   ' });
    r = await agent.get(`/tickets/${newId}`);
    check('staff see the internal notes panel with both notes', r.text.includes('Internal notes') && r.text.includes(NOTE_SECRET) && r.text.includes('Manager note'));
    check('blank note is ignored', (r.text.match(/data-internal-note/g) || []).length === 2);
    check('note text is HTML-escaped', r.text.includes('Manager note &lt;b&gt;bold?&lt;/b&gt;'));
    r = await agent2.get(`/tickets/${newId}`);
    check('other agents see the notes too', r.text.includes(NOTE_SECRET));
    r = await endUser.get(`/tickets/${newId}`);
    check('requester sees neither the notes nor the panel', r.status === 200 && !r.text.includes(NOTE_SECRET) && !r.text.includes('Internal notes') && !r.text.includes('Manager note'));
    r = await endUser.post(`/tickets/${newId}/notes`, { body: 'requester trying to add a note' });
    check('requester cannot add a note to own ticket (403)', r.status === 403);
    r = await agent.get(`/tickets/${newId}`);
    check('...and nothing was stored', !r.text.includes('requester trying to add a note'));
    r = await agent.post('/tickets/T-9999/notes', { body: 'x' });
    check('note on unknown ticket is a 404', r.status === 404);
    r = await endUser.get('/notifications');
    check('notes create no notifications for the requester', !r.text.includes(NOTE_SECRET) && !/note/i.test(r.text.replace(/<[^>]+>/g, ' ').replace(/notifications?/gi, '')));
    r = await agent.post(`/tickets/${newId}/status`, { status: 'Resolved' });
    check('In Progress -> Resolved', r.status === 302 && !r.location.includes('msg='));
    r = await manager.post(`/tickets/${newId}/status`, { status: 'Closed' });
    check('manager closes it', r.status === 302 && !r.location.includes('msg='));
    r = await endUser.get(`/tickets/${newId}`);
    check('requester sees comments and Closed status', r.text.includes('Wired is the same.') && r.text.includes('Looking into it') && r.text.includes('pill-status-closed'));
    r = await manager.post('/tickets/T-1017/assign', { agentEmail: 'agent2@opspilot.test' });
    check('manager assigns an unassigned ticket', r.status === 302 && !r.location.includes('msg='));
    r = await agent.get('/tickets/T-9999');
    check('unknown ticket is a 404', r.status === 404);

    console.log('\nNotifications');
    r = await endUser.get('/notifications');
    check('requester was notified of claim, comment and status changes',
      r.text.includes('Adel Haddad is now working on your ticket') && r.text.includes('Adel Haddad commented on') && r.text.includes('from In Progress to Resolved'));
    check('status notification names the real previous status', !r.text.includes('from Resolved to Resolved'));
    check('requester is not notified about their own comment', !r.text.includes('Erin Carter commented'));
    r = await agent.get('/notifications');
    check('assignee was notified of the requester\'s reply', r.text.includes('Erin Carter commented on'));
    r = await endUser.get('/dashboard');
    const unread = parseInt((r.text.match(/notif-count">(\d+)/) || [])[1] || '0', 10);
    check('nav shows an unread count', unread >= 3, `(got ${unread})`);
    r = await endUser.get('/notifications');
    const firstId = (r.text.match(/\/notifications\/([^/]+)\/open/) || [])[1];
    r = await agent.post(`/notifications/${firstId}/open`);
    check("can't open someone else's notification (404)", r.status === 404);
    r = await endUser.post(`/notifications/${firstId}/open`);
    check('opening a notification goes to its ticket', r.status === 302 && r.location.startsWith('/tickets/T-'));
    await endUser.post('/notifications/read-all');
    r = await endUser.get('/dashboard');
    check('mark all read clears the badge', !r.text.includes('notif-count'));
    r = await agent2.get('/notifications');
    check('agent2 only got their own assignment, not the other ticket\'s events',
      r.text.includes('assigned T-1017') && !r.text.includes('commented on') && !r.text.includes('is now working on'));
    await endUser.post('/tickets', { type: 'incident', department: 'IT', title: 'Whole office offline', description: 'No network anywhere on floor 2', category: 'Network', priority: 'Urgent' });
    r = await agent2.get('/notifications');
    check('Urgent ticket notifies every agent', r.text.includes('New Urgent ticket'));

    console.log('\nConfirm / reject duplicates + merge');
    r = await agent.get(`/tickets/${newId}`);
    const suggested = [...new Set([...r.text.matchAll(new RegExp(`/tickets/${newId}/duplicates/(T-\\d+)/confirm`, 'g'))].map((m) => m[1]))];
    check('each suggestion has Confirm and Reject buttons', suggested.length >= 2 && r.text.includes(`/tickets/${newId}/duplicates/${suggested[0]}/reject`), `(found ${suggested.join(', ')})`);
    const [rejectedId, primaryId] = suggested;
    r = await agent.post(`/tickets/${newId}/duplicates/${rejectedId}/reject`);
    check('agent rejects a suggestion', r.status === 302 && r.location.includes('msg=rejected'));
    r = await agent.get(`/tickets/${newId}`);
    check('rejected pair disappears from the suggestions', !r.text.includes(`/duplicates/${rejectedId}/confirm`) && r.text.includes(`/duplicates/${primaryId}/confirm`));
    r = await agent2.post(`/tickets/${newId}/duplicates/${rejectedId}/reject`);
    check('the same pair cannot be decided twice', r.location.includes('msg=not_suggested') || r.location.includes('msg=already_decided'));
    await agent.post(`/tickets/${newId}/duplicates`);
    r = await agent.get(`/tickets/${newId}`);
    check('re-running the check does not suggest the rejected pair again', !r.text.includes(`/duplicates/${rejectedId}/confirm`) && r.text.includes(`/duplicates/${primaryId}/confirm`));
    r = await agent.post(`/tickets/${newId}/duplicates/${newId}/confirm`);
    check('a ticket cannot be merged into itself', r.location.includes('msg=not_suggested'));
    const notSuggested = ['T-1017', 'T-1018', 'T-1019', 'T-1020', 'T-1010', 'T-1011'].find((id) => !suggested.includes(id));
    r = await agent.post(`/tickets/${newId}/duplicates/${notSuggested}/confirm`);
    check('a pair that was never suggested is refused', r.location.includes('msg=not_suggested'));
    r = await agent.post(`/tickets/${newId}/duplicates/T-9999/confirm`);
    check('unknown ticket is a 404', r.status === 404);

    r = await agent.post(`/tickets/${newId}/duplicates/${primaryId}/confirm`);
    check('agent confirms: redirected to the OLDER ticket', r.status === 302 && r.location.startsWith(`/tickets/${primaryId}?msg=merged`));
    r = await agent.get(`/tickets/${primaryId}`);
    check('primary links the merged ticket', /data-merged-children[\s\S]*?\/tickets\/T-\d+/.test(r.text) && r.text.includes(`>${newId}</a>`));
    check('primary has an internal note with the description and every comment', r.text.includes(`Merged ${newId}`) && r.text.includes('Wired is the same.') && r.text.includes('Looking into it') && r.text.includes('My VPN disconnects'));
    check("...and the merged ticket's own internal notes", r.text.includes(NOTE_SECRET));
    r = await agent.get(`/tickets/${newId}`);
    check('merged ticket is Closed, points to the primary, and keeps its comments', r.text.includes('data-merged-banner') && r.text.includes(`href="/tickets/${primaryId}"`) && r.text.includes('pill-status-closed') && r.text.includes('Wired is the same.'));
    check('merged ticket shows no more Confirm buttons', !r.text.includes('/confirm"'));
    r = await endUser.get(`/tickets/${newId}`);
    check('requester sees "closed as a duplicate" and still has their comments', r.text.includes('closed as a duplicate') && r.text.includes('Wired is the same.'));
    check("...but not the other ticket's ID or the merge note", !r.text.includes(`/tickets/${primaryId}`) && !r.text.includes(`Merged ${newId}`));
    r = await endUser.get('/notifications');
    check('requester is notified of the merge', r.text.includes('as a duplicate of an issue IT is already working on'));
    r = await agent2.post(`/tickets/${primaryId}/duplicates/${newId}/confirm`);
    check('a merged ticket cannot be merged again', r.location.includes('msg=already_merged') || r.location.includes('msg=not_suggested'));
    await agent.post(`/tickets/${primaryId}/duplicates`);
    r = await agent.get(`/tickets/${primaryId}`);
    check('merged ticket is never suggested again', !r.text.includes(`/duplicates/${newId}/confirm`));

    r = await manager.get('/admin/duplicate-stats');
    const allRow = (r.text.match(/data-row="All suggestions">([\s\S]*?)<\/tr>/) || ['', ''])[1];
    const cell = (name) => ((allRow.match(new RegExp(`data-${name}>([^<]*)<`)) || [])[1] || '').trim();
    check('stats page: 1 confirmed, 1 rejected, 50% rate', r.status === 200 && cell('confirmed') === '1' && cell('rejected') === '1' && cell('rate') === '50%', `(got ${cell('confirmed')}/${cell('rejected')}/${cell('rate')})`);
    r = await manager.get('/admin/duplicate-stats.csv');
    const decisionRows = r.text.trim().split('\r\n');
    check('decisions CSV: header + one row per decision, with scores', r.status === 200 && decisionRows.length === 3 && r.text.includes('"baselineScore"') && r.text.includes('"confirmed"') && r.text.includes('"rejected"'), `(got ${decisionRows.length} lines)`);
    check('decisions CSV records the merge direction', r.text.includes(`"${primaryId}","${newId}"`));

    console.log('\nKnowledge base');
    r = await endUser.get('/kb');
    check('end user can browse the KB', r.status === 200 && r.text.includes('VPN keeps disconnecting'));
    check('end user does not see view/vote stats', !r.text.includes('<th>Views</th>'));
    r = await endUser.get('/kb?q=printer');
    check('KB search finds the printer article', r.text.includes('Printer shows offline') && !r.text.includes('/kb/KB-01'));
    r = await endUser.get('/kb/KB-03');
    check('end user can read an article', r.status === 200 && r.text.includes('Was this helpful?'));
    await endUser.get('/kb/KB-03');
    r = await endUser.post('/kb/KB-03/vote', { helpful: 'yes' });
    check('end user can vote', r.location.includes('msg=thanks'));
    await endUser.post('/kb/KB-03/vote', { helpful: 'yes' });
    r = await agent.post('/kb', { title: 'Teams calls echo', body: 'If people hear an echo of themselves on Teams calls, use a headset instead of laptop speakers, or turn on noise suppression in Teams settings.', category: 'Software' });
    const newKb = (r.location.match(/KB-\d+/) || [])[0];
    check('agent can publish an article', r.status === 302 && !!newKb, r.location);
    r = await agent.post(`/kb/${newKb}`, { title: 'Echo on Teams calls', body: 'If people hear an echo of themselves on Teams calls, use a headset instead of laptop speakers.', category: 'Software' });
    check('agent can edit it', r.status === 302);
    r = await manager.get('/dashboard');
    const kbRow = (r.text.match(/<tr>\s*<td><a href="\/kb\/KB-03"[\s\S]*?<\/tr>/) || [''])[0];
    const kbNums = [...kbRow.matchAll(/>(\d+)<\/a><\/td>/g)].map((m) => m[1]).join(',');
    check('manager dashboard shows KB stats (1 view, 1 helpful vote, refresh/double-vote not counted)', kbNums === '1,1,0', `(got ${kbNums})`);
    const kbHelp = await endUser.json('/help/ask', { question: 'people hear an echo on my teams call' });
    check('help assistant finds the new article', kbHelp.body.articles.some((a) => a.articleId === newKb));
    r = await manager.post(`/kb/${newKb}/delete`);
    check('manager can delete it', r.location.includes('msg=deleted'));
    r = await endUser.get(`/kb/${newKb}`);
    check('deleted article is gone (404)', r.status === 404);

    console.log('\nCSV export + evaluation page');
    await endUser.post('/tickets', { type: 'incident', department: 'IT', title: '=HYPERLINK("http://evil.example","click")', description: 'formula injection test', category: 'General', priority: 'Low' });
    r = await manager.get('/reports/tickets.csv');
    check('manager downloads CSV', r.status === 200 && r.text.includes('"ticketId","type","title"'));
    const csvRows = r.text.trim().split('\r\n');
    check('CSV has one row per ticket (+ header)', csvRows.length >= 24, `(got ${csvRows.length})`);
    check('CSV neutralises formulas', r.text.includes(`"'=HYPERLINK(""http://evil.example"",""click"")"`));
    check('CSV never contains internal note text', !r.text.includes(NOTE_SECRET));
    check('CSV includes duplicate + SLA columns', r.text.includes('"aiMatches"') && r.text.includes('"slaOverall"'));
    r = await manager.get('/evaluation');
    check('manager sees the evaluation page', r.status === 200 && r.text.includes('Held-out test') && r.text.includes('F1'));
    if (aiOn) check('evaluation includes the AI method', r.text.includes('AI (embeddings + cosine), threshold'));

    console.log('\nClickable dashboard numbers');
    r = await manager.get('/dashboard');
    // Every link to /tickets?... on the dashboard, with the number it shows.
    const links = [...r.text.matchAll(/<a[^>]*href="(\/tickets(?:\?[^"]*)?)"[^>]*>([\s\S]*?)<\/a>/g)]
      .map((m) => ({ href: m[1].replace(/&amp;/g, '&'), shown: (m[2].replace(/<[^>]+>/g, ' ').match(/\d+/) || [])[0] }))
      .filter((l) => l.shown !== undefined);
    check('dashboard has a link for every number (25+)', links.length >= 25, `(found ${links.length})`);
    const mismatches = [];
    for (const l of links) {
      const page = await manager.get(l.href);
      const listed = (page.text.match(/data-count="(\d+)"/) || [])[1];
      if (page.status !== 200 || listed !== l.shown) mismatches.push(`${l.href} shows ${l.shown}, list has ${listed} (HTTP ${page.status})`);
    }
    check('every dashboard number equals the length of the list it opens', mismatches.length === 0, mismatches.join('; '));
    r = await manager.get('/tickets?state=active&sla=breached');
    check('SLA breached list shows only breached tickets', !/sla-(ok|met|at_risk)"/.test(r.text) && r.text.includes('SLA breached'));
    check('filters show as removable chips', r.text.includes('class="chip"') && r.text.includes('href="/tickets?state=active"'));
    r = await manager.get('/tickets?status=Bogus&priority=Nope&assignee=%3Cscript%3E');
    check('invalid filter values are ignored, not errors', r.status === 200 && !r.text.includes('class="chip"'));
    r = await manager.get('/tickets?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    check('search text is HTML-escaped, never run as script', r.status === 200 && r.text.includes('&lt;script&gt;alert(1)') && !r.text.includes('<script>alert(1)'));
    r = await manager.get('/tickets?q=printer');
    check('search filter works', r.text.includes('Printer on 3rd floor') && !r.text.includes('VPN keeps dropping'));
    r = await agent.get('/tickets?priority=High');
    check('agents can use the filtered list too', r.status === 200 && r.text.includes('Priority: High'));
    const filteredList = await manager.get('/tickets?category=Network');
    const filteredCount = (filteredList.text.match(/data-count="(\d+)"/) || [])[1];
    r = await manager.get('/reports/tickets.csv?category=Network');
    const csvLines = r.text.trim().split('\r\n').length - 1;
    check('filtered CSV export has exactly the listed rows', String(csvLines) === filteredCount && !r.text.includes('"Hardware"'), `(csv ${csvLines}, list ${filteredCount})`);

    console.log('\nCanned responses');
    r = await agent.get('/canned');
    check('agent sees the canned responses page with starter replies', r.status === 200 && r.text.includes('Asking for more details'));
    r = await agent.post('/canned', { title: '<b>Printer</b> reset', body: 'Turn the printer off & on again, then wait 30 seconds.' });
    check('agent adds a canned response', r.status === 302 && r.location.includes('msg=created'));
    r = await agent.post('/canned', { title: '', body: 'no title' });
    check('canned response without a title is rejected (400)', r.status === 400);
    r = await agent.get('/canned');
    check('title is HTML-escaped on the list', r.text.includes('&lt;b&gt;Printer&lt;/b&gt; reset') && !r.text.includes('<b>Printer</b>'));
    const cannedRow = r.text.split('data-canned-row').find((chunk) => chunk.includes('Printer&lt;/b&gt; reset')) || '';
    const cannedId = (cannedRow.match(/\/canned\/([^/"]+)\/edit/) || [])[1];
    check('new response has an edit link', !!cannedId);
    check('agents get no Delete button', !r.text.includes(`/canned/${cannedId}/delete`));
    r = await agent.get('/tickets/T-1005');
    check('staff reply form has the canned dropdown with the escaped text', r.text.includes('data-canned-select') && r.text.includes('value="Turn the printer off &amp; on again, then wait 30 seconds."'));
    r = await endUser.get('/tickets/T-1003');
    check('requester reply form has no canned dropdown', r.status === 200 && !r.text.includes('data-canned'));
    r = await agent.get(`/canned/${cannedId}/edit`);
    check('agent opens the edit form', r.status === 200 && r.text.includes('Turn the printer off &amp; on again'));
    r = await agent.post(`/canned/${cannedId}`, { title: 'Printer reset', body: 'Turn the printer off and on again.' });
    check('agent edits it', r.status === 302 && r.location.includes('msg=saved'));
    r = await agent.get('/canned');
    check('edit is saved', r.text.includes('Printer reset') && r.text.includes('Turn the printer off and on again.') && !r.text.includes('wait 30 seconds'));
    r = await agent.get('/canned/does-not-exist/edit');
    check('unknown canned response is a 404', r.status === 404);
    r = await manager.get('/canned');
    check('managers get a Delete button', r.text.includes(`/canned/${cannedId}/delete`));
    r = await manager.post(`/canned/${cannedId}/delete`);
    check('manager deletes it', r.status === 302 && r.location.includes('msg=deleted'));
    r = await agent.get('/canned');
    check('deleted response is gone', !r.text.includes('Printer reset'));
    r = await manager.post(`/canned/${cannedId}/delete`);
    check('deleting it again is a 404', r.status === 404);

    console.log('\nAdmin: users and roles');
    r = await admin.get('/admin/users');
    check('admin sees every user with a role dropdown', r.status === 200 && r.text.includes('data-user="agent2@opspilot.test"') && r.text.includes('name="role"'));
    check('admin has no dropdown for their own row', !/data-user="admin@opspilot.test"[\s\S]*?<\/tr>/.exec(r.text)[0].includes('name="role"'));
    r = await admin.get('/dashboard');
    check('admin gets the manager dashboard', r.text.includes('SLA watch'));
    r = await admin.get('/audit');
    check('admin can open manager pages (audit log)', r.status === 200);
    r = await admin.post('/admin/users/role', { email: 'admin@opspilot.test', role: 'agent' });
    check('admin cannot change their own role', r.location.includes('msg=self'));
    r = await admin.post('/admin/users/role', { email: 'agent2@opspilot.test', role: 'superuser' });
    check('unknown role is rejected (400)', r.status === 400);
    r = await admin.post('/admin/users/role', { email: 'nobody@opspilot.test', role: 'agent' });
    check('unknown user is a 404', r.status === 404);
    r = await agent2.get('/tickets');
    check('agent2 can see the ticket list before', r.status === 200);
    r = await admin.post('/admin/users/role', { email: 'agent2@opspilot.test', role: 'end_user' });
    check('admin demotes agent2 to end user', r.location.includes('msg=role_changed'));
    r = await agent2.get('/tickets');
    check('...which takes effect on agent2\'s next request, without logging out', r.status === 403);
    r = await admin.post('/admin/users/role', { email: 'agent2@opspilot.test', role: 'end_user' });
    check('setting the same role again is reported, not logged', r.location.includes('msg=unchanged'));
    r = await admin.post('/admin/users/role', { email: 'manager@opspilot.test', role: 'admin' });
    check('admin promotes the manager to admin', r.location.includes('msg=role_changed'));
    r = await manager.get('/admin/users');
    check('the new admin can open user management', r.status === 200);
    r = await manager.post('/admin/users/role', { email: 'admin@opspilot.test', role: 'manager' });
    check('with two admins, one can demote the other', r.location.includes('msg=role_changed'));
    r = await admin.get('/admin/users');
    check('the demoted admin loses access straight away', r.status === 403);
    r = await manager.post('/admin/users/role', { email: 'manager@opspilot.test', role: 'manager' });
    check('the last admin cannot demote themselves', r.location.includes('msg=self'));
    // Restore the starting roles for the rest of the test.
    await manager.post('/admin/users/role', { email: 'admin@opspilot.test', role: 'admin' });
    r = await admin.post('/admin/users/role', { email: 'manager@opspilot.test', role: 'manager' });
    check('roles restored', r.location.includes('msg=role_changed'));
    r = await admin.post('/admin/users/role', { email: 'agent2@opspilot.test', role: 'agent' });
    r = await agent2.get('/tickets');
    check('agent2 is an agent again', r.status === 200);

    console.log('\nPermissions page');
    r = await admin.get('/admin/permissions');
    check('admin sees the permission matrix from lib/permissions.js', r.status === 200 && r.text.includes('data-permission="report.export"') && r.text.includes('data-permission="settings.edit"'));
    check('matrix: managers can export, agents cannot', /data-permission="report.export"[\s\S]*?data-role="agent" data-allowed="false"[\s\S]*?data-role="manager" data-allowed="true"/.test(r.text));
    r = await manager.get('/admin/permissions');
    check('managers cannot open the permissions page (403)', r.status === 403);
    r = await admin.get('/dashboard');
    check("the sidebar shows the admin's role label", /<p class="text-xs text-muted">Admin<\/p>/.test(r.text));

    console.log('\nDepartments + org structure');
    r = await admin.get('/admin/departments');
    check('departments page lists the seeded departments', r.status === 200 && ['IT', 'HR', 'FIN', 'FAC', 'OPS', 'PROC'].every((c) => r.text.includes(`data-dept="${c}"`)));
    r = await admin.post('/admin/departments', { code: 'qa', name: 'Quality Assurance' });
    check('admin adds a department (code upper-cased)', r.location.includes('msg=created'));
    r = await admin.post('/admin/departments', { code: 'QA', name: 'Duplicate' });
    check('duplicate department code is refused', r.location.includes('msg=code_taken'));
    r = await admin.post('/admin/departments', { code: '<x>', name: 'Bad' });
    check('invalid department code is refused', r.location.includes('msg=bad_input'));
    r = await admin.post('/admin/departments/QA/head', { headEmail: 'agent2@opspilot.test' });
    check('admin sets a department head', r.location.includes('msg=head_changed'));
    r = await admin.get('/admin/departments');
    check('...and it shows as selected', /data-dept="QA"[\s\S]*?value="agent2@opspilot.test" selected/.test(r.text));
    r = await admin.post('/admin/departments/QA/head', { headEmail: 'nobody@opspilot.test' });
    check('a head who is not a user is refused', r.location.includes('msg=bad_head'));
    r = await admin.post('/admin/departments/NOPE/head', { headEmail: '' });
    check('unknown department is a 404', r.status === 404);
    r = await admin.get('/admin/users');
    const erinRow = (/data-user="enduser@opspilot.test"[\s\S]*?<\/tr>/.exec(r.text) || [''])[0];
    check("users page shows Erin's department and line manager", /value="FIN" selected/.test(erinRow) && /value="lead@opspilot.test" selected/.test(erinRow));
    r = await admin.post('/admin/users/org', { email: 'agent2@opspilot.test', department: 'QA', managerEmail: 'agent@opspilot.test' });
    check('admin sets department + line manager', r.location.includes('msg=org_changed'));
    r = await admin.post('/admin/users/org', { email: 'agent@opspilot.test', department: 'IT', managerEmail: 'agent2@opspilot.test' });
    check('a management loop is refused (A -> B -> A)', r.location.includes('msg=manager_loop'));
    r = await admin.post('/admin/users/org', { email: 'agent@opspilot.test', department: 'IT', managerEmail: 'agent@opspilot.test' });
    check('nobody can be their own line manager', r.location.includes('msg=self_manager'));
    r = await admin.post('/admin/users/org', { email: 'agent@opspilot.test', department: 'NOPE', managerEmail: '' });
    check('unknown department is refused', r.location.includes('msg=bad_department'));
    r = await admin.post('/admin/users/org', { email: 'agent@opspilot.test', department: 'IT', managerEmail: 'ghost@opspilot.test' });
    check('a line manager who is not a user is refused', r.location.includes('msg=bad_manager'));
    await admin.post('/admin/users/org', { email: 'agent2@opspilot.test', department: 'IT', managerEmail: 'manager@opspilot.test' });

    r = await agent.get('/tickets/T-1005');
    check('ticket page shows its department', r.text.includes('data-department="IT"') && r.text.includes('Information Technology'));
    r = await agent.post('/tickets/T-1005/department', { department: 'FAC' });
    check('agent re-routes a ticket to Facilities', r.location.includes('msg=rerouted'));
    r = await agent.post('/tickets/T-1005/department', { department: 'NOPE' });
    check('re-routing to an unknown department is refused (400)', r.status === 400);
    r = await manager.get('/tickets?department=FAC');
    const facCount = (r.text.match(/data-count="(\d+)"/) || [])[1];
    check('department filter lists it, with a chip', r.text.includes('data-ticket="T-1005"') && r.text.includes('Department: Facilities') && (r.text.match(/data-ticket="/g) || []).length === Number(facCount));
    r = await manager.get('/tickets?department=IT');
    check('...and it left the IT list', !r.text.includes('data-ticket="T-1005"') && r.text.includes('dept-tag'));
    r = await manager.get('/reports/tickets.csv?department=FAC');
    check('CSV export has a department column and honours the filter', r.text.includes('"department"') && r.text.includes('"T-1005"') && r.text.trim().split('\r\n').length === Number(facCount) + 1);

    console.log('\nApproval workflow (service requests)');
    // Erin (Finance) -> line manager Khalid -> head of Finance Layla -> head of the target department.
    const createRequest = async (c, department, title) => {
      const res = await c.post('/tickets', { type: 'service_request', department, title, description: `${title} (details)`, justification: 'Needed for my job', priority: 'Medium' });
      return (res.location.match(/T-\d+/) || [])[0];
    };
    // Step ID of the pending step on a ticket, from the approver's ticket page.
    const pendingStep = async (c, ticketId) => ((await c.get(`/tickets/${ticketId}`)).text.match(/data-approval-actions="([^"]+)"/) || [])[1];
    const stepStatuses = (html) => [...html.matchAll(/data-step="(\d)" data-step-status="(\w+)"/g)].map((m) => `${m[1]}:${m[2]}`).join(' ');

    const sr1 = await createRequest(endUser, 'IT', 'New laptop with 32GB RAM');
    r = await endUser.get(`/tickets/${sr1}`);
    check('service request starts Pending Approval with the full chain', r.text.includes('pill-status-pending-approval') && stepStatuses(r.text) === '1:pending 2:waiting 3:waiting', stepStatuses(r.text));
    check('requester sees who approves each step', r.text.includes('Khalid Mansoor') && r.text.includes('Layla Nasser') && r.text.includes('Mona Saleh'));
    check('its SLA has not started', r.text.includes('SLA not started') && r.text.includes('starts when approved'));
    r = await agent.get('/dashboard');
    check("it is NOT in the agents' open queue", !r.text.includes(`data-ticket="${sr1}"`));
    r = await agent.post(`/tickets/${sr1}/claim`);
    check('agents cannot claim it before approval', r.location.includes('msg=not_approved'));
    r = await lead.get('/approvals');
    check("it is in the line manager's My approvals, with a nav badge", r.text.includes(`data-ticket-id="${sr1}"`) && r.text.includes('approval-count'));
    r = await finhead.get('/approvals');
    check('...but not yet in the head of department\'s', !r.text.includes(`data-ticket-id="${sr1}"`));
    r = await endUser.get('/notifications');
    r = await lead.get('/notifications');
    check('line manager is notified', r.text.includes(`request ${sr1}`) && r.text.includes('needs your approval'));
    const s1 = await pendingStep(lead, sr1);
    check('line manager sees Approve/Reject on the ticket page', !!s1);
    for (const [c, who] of [[finhead, 'a later approver'], [agent, 'an agent'], [endUser, 'the requester'], [admin, 'an admin']]) {
      r = await c.post(`/approvals/${s1}/approve`, {});
      check(`${who} cannot decide the line manager's step (403)`, r.status === 403, `(got ${r.status})`);
    }
    r = await lead.post(`/approvals/${s1}/reject`, { comment: '   ' });
    check('rejecting without a reason is refused', r.location.includes('msg=reason_required'));
    r = await lead.post(`/approvals/${s1}/approve`, { comment: 'Fine by me', returnTo: 'list' });
    check('line manager approves', r.location.startsWith('/approvals?msg=approved'));
    r = await lead.post(`/approvals/${s1}/approve`, {});
    check('the same step cannot be decided twice', r.location.includes('msg=not_pending'));
    r = await finhead.get('/notifications');
    check('head of department is notified next', r.text.includes(`request ${sr1}`));
    const s2 = await pendingStep(finhead, sr1);
    r = await finhead.post(`/approvals/${s2}/approve`, {});
    check('head of requester\'s department approves', r.location.includes('msg=approved'));
    r = await endUser.get(`/tickets/${sr1}`);
    check('now waiting for the target department\'s head', stepStatuses(r.text) === '1:approved 2:approved 3:pending' && r.text.includes('Fine by me'));
    const s3 = await pendingStep(manager, sr1);
    r = await manager.post(`/approvals/${s3}/approve`, {});
    check('head of IT (the target) approves', r.location.includes('msg=approved'));
    r = await endUser.get(`/tickets/${sr1}`);
    check('approved: Open, all steps approved, SLA running', r.text.includes('pill-status-open') && stepStatuses(r.text) === '1:approved 2:approved 3:approved' && !r.text.includes('SLA not started'));
    r = await endUser.get('/notifications');
    check('requester is told it was approved', r.text.includes(`Your request ${sr1}`) && r.text.includes('was approved'));
    r = await agent.get('/dashboard');
    check("it is now in the agents' open queue", r.text.includes(`data-ticket="${sr1}"`));

    const sr2 = await createRequest(endUser, 'IT', 'Second monitor');
    const r2 = await pendingStep(lead, sr2);
    r = await lead.post(`/approvals/${r2}/reject`, { comment: 'Budget is <b>frozen</b> this quarter' });
    check('line manager rejects with a reason', r.location.includes('msg=request_rejected'));
    r = await endUser.get(`/tickets/${sr2}`);
    check('rejected: status Rejected, later steps skipped, reason shown escaped',
      r.text.includes('pill-status-rejected') && stepStatuses(r.text) === '1:rejected 2:skipped 3:skipped' && r.text.includes('Budget is &lt;b&gt;frozen&lt;/b&gt;'));
    r = await endUser.get('/notifications');
    check('requester is notified with the reason', r.text.includes(`did not approve your request ${sr2}`) && r.text.includes('frozen'));
    r = await agent.post(`/tickets/${sr2}/claim`);
    check('a rejected request cannot be claimed', r.location.includes('msg=not_approved'));

    // Khalid (manager: Layla) asks Finance: Layla is both his line manager
    // and his department head, and Finance is his own department.
    const sr3 = await createRequest(lead, 'FIN', 'Access to the budget workbook');
    r = await finhead.post(`/approvals/${await pendingStep(finhead, sr3)}/approve`, {});
    r = await lead.get(`/tickets/${sr3}`);
    check('same person is not asked twice, same department skips the target head -> Open',
      r.text.includes('pill-status-open') && stepStatuses(r.text) === '1:approved 2:skipped 3:skipped' && r.text.includes('Same person already approved at step 1'));

    // Layla (no line manager, head of Finance) asks Finance: every step is
    // her own or doesn't apply.
    const sr4 = await createRequest(finhead, 'FIN', 'New team mailbox');
    r = await finhead.get(`/tickets/${sr4}`);
    check('head requesting for own department: all steps skipped, straight to the queue',
      r.text.includes('pill-status-open') && stepStatuses(r.text) === '1:skipped 2:skipped 3:skipped' && r.text.includes('has no line manager') && r.text.includes('nobody approves their own request'));
    const sr5 = await createRequest(finhead, 'IT', 'Tableau licence');
    r = await finhead.get(`/tickets/${sr5}`);
    check("head requesting from IT: only IT's head approves", stepStatuses(r.text) === '1:skipped 2:skipped 3:pending');

    // HR has no head: the last step waits unassigned for an admin.
    const sr6 = await createRequest(endUser, 'HR', 'Update my job title');
    await lead.post(`/approvals/${await pendingStep(lead, sr6)}/approve`, {});
    await finhead.post(`/approvals/${await pendingStep(finhead, sr6)}/approve`, {});
    r = await endUser.get(`/tickets/${sr6}`);
    check('department without a head: step waits unassigned (never skipped)', stepStatuses(r.text) === '1:approved 2:approved 3:pending' && r.text.includes('an admin will assign one'));
    r = await admin.get('/admin/approvals');
    const sr6Row = (new RegExp(`data-open-step="([^"]+)" data-ticket-id="${sr6}"[\\s\\S]*?</tr>`).exec(r.text) || ['', ''])
    check('admin sees it flagged as unassigned', sr6Row[0].includes('Unassigned'));
    r = await admin.post(`/admin/approvals/${sr6Row[1]}/reassign`, { approverEmail: 'enduser@opspilot.test' });
    check('admin cannot give a step to the requester', r.location.includes('msg=own_request'));
    r = await admin.post('/admin/departments/HR/head', { headEmail: 'agent2@opspilot.test' });
    r = await agent2.get('/approvals');
    check('setting a head for HR assigns the waiting step to them', r.text.includes(`data-ticket-id="${sr6}"`));
    r = await agent2.post(`/approvals/${await pendingStep(agent2, sr6)}/approve`, {});
    r = await endUser.get(`/tickets/${sr6}`);
    check('...who approves it, and it opens in HR', r.text.includes('pill-status-open') && r.text.includes('data-department="HR"'));
    await admin.post('/admin/departments/HR/head', { headEmail: '' });

    // Approver changes mid-flow: Erin gets a new line manager.
    const sr7 = await createRequest(endUser, 'IT', 'Adobe Acrobat Pro');
    await admin.post('/admin/users/org', { email: 'enduser@opspilot.test', department: 'FIN', managerEmail: 'agent2@opspilot.test' });
    r = await admin.get('/admin/approvals');
    const sr7Row = (new RegExp(`data-open-step="([^"]+)" data-ticket-id="${sr7}"[\\s\\S]*?</tr>`).exec(r.text) || ['', ''])
    check("admin page flags the step whose approver is no longer the line manager", sr7Row[0].includes('org chart changed') && sr7Row[0].includes('Sara Ali'));
    r = await admin.post(`/admin/approvals/${sr7Row[1]}/reassign`, { approverEmail: 'agent2@opspilot.test' });
    check('admin reassigns the pending step', r.location.includes('msg=reassigned'));
    r = await lead.post(`/approvals/${sr7Row[1]}/approve`, {});
    check('the old approver can no longer act (403)', r.status === 403);
    r = await agent2.get('/notifications');
    check('the new approver is notified', r.text.includes(`request ${sr7}`));
    r = await agent2.post(`/approvals/${sr7Row[1]}/approve`, {});
    check('the new approver can approve', r.location.includes('msg=approved'));
    await admin.post('/admin/users/org', { email: 'enduser@opspilot.test', department: 'FIN', managerEmail: 'lead@opspilot.test' });
    r = await endUser.get('/tickets/T-1003');
    check('incidents have no approval panel', r.status === 200 && !r.text.includes('id="approval"'));

    console.log('\nAdmin settings: duplicate thresholds');
    r = await admin.get('/admin/settings');
    check('admin sees both live thresholds with explanations', r.status === 200 && r.text.includes('data-live="0.1"') && r.text.includes('Raising it') && r.text.includes('Lowering it'));
    r = await manager.get('/admin/settings');
    check('managers cannot open settings (403)', r.status === 403);
    r = await agent.post('/admin/settings/thresholds', { key: 'baselineThreshold', value: '0.5' });
    check('agents cannot change a threshold (403)', r.status === 403);
    r = await admin.post('/admin/settings/thresholds', { key: 'baselineThreshold', value: '1.5' });
    check('out-of-range threshold is refused', r.location.includes('msg=out_of_range_baselineThreshold'));
    r = await admin.post('/admin/settings/thresholds', { key: 'bogus', value: '0.5' });
    check('unknown setting is refused (400)', r.status === 400);
    r = await admin.post('/admin/settings/thresholds', { key: 'baselineThreshold', value: '0.5' });
    check('admin raises the baseline threshold to 0.5', r.location.includes('msg=saved_baselineThreshold'));
    r = await admin.get('/admin/settings');
    check('...shown as in use, set by the admin', r.text.includes('data-live="0.5"') && r.text.includes('set by Omar Haidar'));
    r = await agent.get('/tickets/T-1002');
    check('an older check says it used a different threshold', r.text.includes('the current setting is 50%'));
    r = await agent.post('/tickets/T-1002/duplicates');
    r = await agent.get('/tickets/T-1002');
    check('re-running uses the new threshold', r.text.includes('data-threshold="0.5"'));
    r = await manager.get('/evaluation');
    check('the evaluation still uses the tuned thresholds', r.text.includes('Baseline (keywords + Jaccard), threshold 0.1') && !r.text.includes('threshold 0.5'));
    r = await admin.post('/admin/settings/thresholds', { key: 'baselineThreshold', reset: '1' });
    check('reset goes back to the tuned value', r.location.includes('msg=saved_baselineThreshold'));
    r = await admin.post('/admin/settings/recheck');
    check('admin re-checks all active tickets', /msg=rechecked_\d+/.test(r.location));
    r = await agent.get('/tickets/T-1002');
    check('...and suggestions use the tuned threshold again', r.text.includes('data-threshold="0.1"') && !r.text.includes('the current setting is'));

    console.log('\nAudit log + help assistant');
    r = await manager.get('/audit');
    check('audit log lists actions', r.status === 200 && ['ticket.create', 'ticket.claim', 'ticket.status', 'ticket.comment', 'kb.create', 'kb.delete', 'report.export'].every((a) => r.text.includes(a)));
    check('audit hash chain verifies', r.text.includes('Hash chain intact'));
    check('audit logs duplicate decisions', r.text.includes('duplicate.confirm') && r.text.includes('duplicate.reject'));
    check('audit logs role changes with old and new role', r.text.includes('user.role') && r.text.includes('&#34;from&#34;:&#34;agent&#34;,&#34;to&#34;:&#34;end_user&#34;'));
    check('audit logs threshold changes and re-checks', r.text.includes('settings.threshold') && r.text.includes('settings.recheck'));
    check('audit logs every approval decision and reassignment', ['approval.start', 'approval.approve', 'approval.reject', 'approval.reassign', 'approval.assign_head'].every((a) => r.text.includes(a)));
    check('audit logs canned response changes', ['canned.create', 'canned.update', 'canned.delete'].every((a) => r.text.includes(a)));
    check('audit logs that a note was added, not what it says', r.text.includes('ticket.note') && !r.text.includes(NOTE_SECRET));
    const help = await endUser.json('/help/ask', { question: 'I forgot my password' });
    check('help assistant returns the password article', help.status === 200 && help.body.articles.some((a) => a.articleId === 'KB-02'));
    r = await endUser.get('/help?q=printer+offline');
    check('help page works without JavaScript', r.status === 200 && r.text.includes('Printer shows offline'));

    console.log('\nLogout');
    r = await endUser.post('/logout');
    r = await endUser.get('/dashboard');
    check('after logout, dashboard redirects to login', r.status === 302 && r.location === '/login');
  } finally {
    proc.kill();
  }
  await unitChecks();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
