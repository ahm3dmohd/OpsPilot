require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const methodOverride = require('method-override');
const path = require('path');
const store = require('./lib/store');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Middleware ----
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 }, // 8 hours
  })
);

// Make the logged-in user available to every view without passing it
// explicitly from each route.
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
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
  store.initMockData();
  console.log('Demo logins (password123): enduser@opspilot.test / agent@opspilot.test / manager@opspilot.test');
}

async function connectDatabase() {
  if (!process.env.MONGODB_URI) {
    useMockData('No MONGODB_URI set');
    return;
  }
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    // Stop mongoose retrying in the background, otherwise a late connect
    // would silently switch the store from mock data to the real DB mid-run.
    await mongoose.disconnect().catch(() => {});
    useMockData('Could not reach MongoDB');
  }
}

// ---- Routes ----
const authRoutes = require('./routes/auth.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const ticketsRoutes = require('./routes/tickets.routes');

app.use('/', authRoutes);
app.use('/', dashboardRoutes);
app.use('/tickets', ticketsRoutes);

// ---- 404 ----
app.use((req, res) => {
  res.status(404).render('404', { url: req.originalUrl });
});

connectDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`OpsPilot running on http://localhost:${PORT}`);
  });
});
