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
    for (const [c, email] of [[endUser, 'enduser'], [agent, 'agent'], [agent2, 'agent2'], [manager, 'manager'], [admin, 'admin']]) {
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
    r = await endUser.post('/tickets/new/suggest', { title: 'VPN connection keeps dropping', description: 'My VPN disconnects every few minutes when working from home' });
    check('suggest returns the form with a suggested category', r.status === 200 && r.text.includes('Suggested: <strong>Network</strong>'));
    check('suggest shows a help article before filing', r.text.includes('VPN keeps disconnecting'));
    r = await endUser.post('/tickets', {
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
    r = await endUser.post('/tickets', { title: '', description: '' });
    check('empty ticket is rejected (400)', r.status === 400);

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
    check('agent queue shows a duplicate badge', r.text.includes('Dup? AI'));

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
    await endUser.post('/tickets', { title: 'Whole office offline', description: 'No network anywhere on floor 2', category: 'Network', priority: 'Urgent' });
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
    await endUser.post('/tickets', { title: '=HYPERLINK("http://evil.example","click")', description: 'formula injection test', category: 'General', priority: 'Low' });
    r = await manager.get('/reports/tickets.csv');
    check('manager downloads CSV', r.status === 200 && r.text.includes('"ticketId","title"'));
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

    console.log('\nAudit log + help assistant');
    r = await manager.get('/audit');
    check('audit log lists actions', r.status === 200 && ['ticket.create', 'ticket.claim', 'ticket.status', 'ticket.comment', 'kb.create', 'kb.delete', 'report.export'].every((a) => r.text.includes(a)));
    check('audit hash chain verifies', r.text.includes('Hash chain intact'));
    check('audit logs duplicate decisions', r.text.includes('duplicate.confirm') && r.text.includes('duplicate.reject'));
    check('audit logs role changes with old and new role', r.text.includes('user.role') && r.text.includes('&#34;from&#34;:&#34;agent&#34;,&#34;to&#34;:&#34;end_user&#34;'));
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
