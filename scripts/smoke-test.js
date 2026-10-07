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

    console.log('Auth');
    let r = await anon.get('/dashboard');
    check('logged-out user is sent to /login', r.status === 302 && r.location === '/login');
    r = await anon.post('/login', { email: 'agent@opspilot.test', password: 'wrong' });
    check('wrong password is rejected (401)', r.status === 401);
    for (const [c, email] of [[endUser, 'enduser'], [agent, 'agent'], [agent2, 'agent2'], [manager, 'manager']]) {
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
      [agent, 'GET', '/tickets/new', 'agent -> new ticket form'],
      [agent, 'POST', '/tickets', 'agent -> create ticket'],
      [agent, 'GET', '/audit', 'agent -> audit log'],
      [agent, 'POST', '/tickets/T-1001/assign', 'agent -> assign'],
      [manager, 'GET', '/tickets/new', 'manager -> new ticket form (by design)'],
      [manager, 'POST', '/tickets', 'manager -> create ticket'],
      [manager, 'POST', '/tickets/T-1001/claim', 'manager -> claim'],
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
    check('ticket is now In Progress and assigned', r.text.includes('In Progress') && r.text.includes('Assigned to Adel Haddad'));
    r = await agent.post(`/tickets/${newId}/comment`, { body: 'Looking into it - can you try a wired connection?' });
    check('agent comments', r.status === 302);
    r = await endUser.post(`/tickets/${newId}/comment`, { body: 'Wired is the same.' });
    check('requester replies on own ticket', r.status === 302);
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

    console.log('\nAudit log + help assistant');
    r = await manager.get('/audit');
    check('audit log lists actions', r.status === 200 && r.text.includes('ticket.create') && r.text.includes('ticket.claim') && r.text.includes('ticket.status') && r.text.includes('ticket.comment'));
    check('audit hash chain verifies', r.text.includes('Hash chain intact'));
    const help = await endUser.json('/help/ask', { question: 'I forgot my password' });
    check('help assistant returns the password article', help.status === 200 && help.body.articles.some((a) => a.id === 'KB-02'));
    r = await endUser.get('/help?q=printer+offline');
    check('help page works without JavaScript', r.status === 200 && r.text.includes('Printer shows offline'));

    console.log('\nLogout');
    r = await endUser.post('/logout');
    r = await endUser.get('/dashboard');
    check('after logout, dashboard redirects to login', r.status === 302 && r.location === '/login');
  } finally {
    proc.kill();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
