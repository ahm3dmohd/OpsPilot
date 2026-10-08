require('dotenv').config();
const mongoose = require('mongoose');
// Must be set before any model is loaded. With buffering off, a query made
// while the DB is down fails straight away (and shows the error page)
// instead of hanging for 10 seconds.
mongoose.set('bufferCommands', false);
const express = require('express');
const session = require('express-session');
const methodOverride = require('method-override');
const path = require('path');
const store = require('./lib/store');
const embeddings = require('./lib/embeddings');
const { detectDuplicates, ensureEmbeddings } = require('./lib/duplicates');
const { DEMO_USERS, DEMO_PASSWORD } = require('./lib/seedData');
const viewHelpers = require('./lib/viewHelpers');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// ---- Session secret ----
// SESSION_SECRET signs the session cookie: anyone who knows it can forge a
// login as any user, including a manager. Treat it like a password - long
// and random, kept only in .env, never committed or shared.
if (!process.env.SESSION_SECRET) {
  if (isProduction) {
    console.error('SESSION_SECRET must be set in production. Refusing to start.');
    process.exit(1);
  }
  console.warn('WARNING: SESSION_SECRET not set - using an insecure development secret.');
}

// ---- Middleware ----
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
Object.assign(app.locals, viewHelpers); // icon(), timeAgo(), ... in every template
if (isProduction) app.set('trust proxy', 1); // so secure cookies work behind a hosting proxy
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(express.json({ limit: '50kb' }));
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    name: 'opspilot.sid',
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
      httpOnly: true, // page scripts can't read the cookie
      sameSite: 'lax', // other sites can't make the browser POST with it
      secure: isProduction, // HTTPS-only when deployed
    },
  })
);

// Make the logged-in user available to every view without passing it
// explicitly from each route.
app.use(async (req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.currentPath = req.path;
  res.locals.unreadCount = 0;
  // Unread badge for the nav bar. A failure here (e.g. DB hiccup) just
  // hides the badge rather than breaking the page.
  if (req.session.user && store.getMode()) {
    try {
      res.locals.unreadCount = await store.countUnreadNotifications(req.session.user.email);
    } catch (err) {
      console.error('Unread count failed:', err.message);
    }
  }
  next();
});

// ---- Database ----
// Optional: with no MONGODB_URI set, or if the database can't be reached,
// the app runs in mock-data mode (lib/store.js reads/writes in-memory
// instead of Mongo), which is enough to log in and use the whole app with
// zero setup. The server only starts listening once the mode is decided,
// so no request ever lands on an empty mock store.

function useMockData(reason) {
  console.log(`${reason} - running in mock-data mode (no DB).`);
  store.useMockData();
  console.log(`Demo logins (${DEMO_PASSWORD}): ${DEMO_USERS.map((u) => u.email).join(' / ')}`);
}

async function connectDatabase() {
  if (!process.env.MONGODB_URI) {
    useMockData('No MONGODB_URI set');
    return;
  }
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    store.useDatabase();
    await store.syncCounters();
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    // Stop mongoose retrying in the background, otherwise a late connect
    // would leave a half-open connection nobody uses.
    await mongoose.disconnect().catch(() => {});
    useMockData('Could not reach MongoDB');
  }
}

// Fills in embeddings and duplicate results for tickets that don't have
// them yet (the seed tickets on first start), so the duplicates panel is
// populated straight away. Runs in the background after startup; with
// cached embeddings it costs no API calls.
async function warmUp() {
  try {
    const all = await store.listTickets({}, { withEmbeddings: true });
    if (embeddings.isConfigured()) {
      const ready = await ensureEmbeddings(all);
      console.log(`AI duplicate detection: ${ready.status === 'ok' ? `on (${ready.model})` : `${ready.status} - ${ready.reason}`}`);
    } else {
      console.log('AI duplicate detection: skipped (no LLM_API_KEY) - keyword baseline only.');
    }
    const pending = all.filter((t) => !t.duplicates);
    for (const t of pending) await detectDuplicates(t.ticketId);
    if (pending.length) console.log(`Ran duplicate detection on ${pending.length} existing tickets.`);
  } catch (err) {
    console.error('Startup duplicate check failed:', err.message);
  }
}

// ---- Routes ----
app.use('/', require('./routes/auth.routes'));
app.use('/', require('./routes/dashboard.routes'));
app.use('/', require('./routes/admin.routes'));
app.use('/tickets', require('./routes/tickets.routes'));
app.use('/kb', require('./routes/kb.routes'));
app.use('/notifications', require('./routes/notifications.routes'));
app.use('/canned', require('./routes/canned.routes'));

// ---- 404 ----
app.use((req, res) => {
  res.status(404).render('404', { url: req.originalUrl });
});

// ---- Errors ----
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('500', { title: 'Something went wrong' });
});

connectDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`OpsPilot running on http://localhost:${PORT}`);
    warmUp();
  });
});
