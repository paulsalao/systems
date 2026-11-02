require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const DATABASE_PATH = path.resolve(ROOT, process.env.DB_PATH || './data/bookings.sqlite');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const UNITS = {
  'Unit 101': 'Regular',
  'Unit 102': 'Regular',
  'Unit 103': 'Regular',
  'Unit 104': 'Regular',
  'Deluxe Unit 201': 'Deluxe',
  'Deluxe Unit 202': 'Deluxe'
};
const DEFAULT_BLOCKS = {
  'Unit 101': [['09:00', '11:00'], ['14:00', '16:00']],
  'Unit 102': [['10:30', '12:30']],
  'Unit 103': [['13:00', '15:00']],
  'Unit 104': [['11:00', '13:00']],
  'Deluxe Unit 201': [['12:00', '14:00']],
  'Deluxe Unit 202': [['15:00', '17:00']]
};

if (ADMIN_PASSWORD.length < 12) {
  throw new Error('Set ADMIN_PASSWORD to a unique value with at least 12 characters.');
}
if (SESSION_SECRET.length < 32) {
  throw new Error('Set SESSION_SECRET to a random value with at least 32 characters.');
}

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
const db = new Database(DATABASE_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY,
    unit TEXT NOT NULL,
    customer TEXT,
    contact TEXT,
    category TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    price INTEGER NOT NULL,
    booking_date TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('customer', 'admin', 'default')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS bookings_date_unit ON bookings (booking_date, unit);
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires);
  CREATE TABLE IF NOT EXISTS default_block_dates (
    booking_date TEXT PRIMARY KEY
  );
`);
db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());

function manilaDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function ensureDefaultBlocksForDate(date) {
  const seedDefaults = db.transaction(() => {
    const seeded = db.prepare('SELECT booking_date FROM default_block_dates WHERE booking_date = ?').get(date);
    if (seeded) return;
    const insertDefault = db.prepare(`
      INSERT INTO bookings
        (unit, category, start_time, end_time, duration_minutes, price, booking_date, source)
      VALUES (?, ?, ?, ?, ?, 0, ?, 'default')
    `);
    for (const [unit, ranges] of Object.entries(DEFAULT_BLOCKS)) {
      for (const [start, end] of ranges) {
        const duration = minutes(end) - minutes(start);
        insertDefault.run(unit, UNITS[unit], start, end, duration, date);
      }
    }
    db.prepare('INSERT INTO default_block_dates (booking_date) VALUES (?)').run(date);
  });
  seedDefaults();
}

ensureDefaultBlocksForDate(manilaDate());

const passwordSalt = crypto.randomBytes(16);
const configuredPasswordHash = crypto.scryptSync(ADMIN_PASSWORD, passwordSalt, 64);
const app = express();

class SQLiteSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);
      if (row.expires <= Date.now()) {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      const expires = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 8 * 60 * 60 * 1000;
      db.prepare(`
        INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
      `).run(sid, JSON.stringify(sess), expires);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sess, callback = () => {}) {
    this.set(sid, sess, callback);
  }
}

const sqliteSessionStore = new SQLiteSessionStore();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '10kb' }));
app.use(session({
  name: 'lodge.admin',
  store: sqliteSessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

function minutes(time) {
  const [hours, mins] = time.split(':').map(Number);
  return hours * 60 + mins;
}

function isValidTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isValidUnit(value) {
  return Object.prototype.hasOwnProperty.call(UNITS, value);
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Admin login required.' });
  next();
}

function findConflict(unit, startTime, endTime, date) {
  return db.prepare(`
    SELECT start_time AS start, end_time AS end
    FROM bookings
    WHERE unit = ? AND booking_date = ?
      AND start_time < ? AND end_time > ?
    LIMIT 1
  `).get(unit, date, endTime, startTime);
}

function getTodayBookings() {
  const date = manilaDate();
  ensureDefaultBlocksForDate(date);
  return db.prepare(`
    SELECT id, unit, customer, contact, category,
           start_time AS start, end_time AS end,
           duration_minutes AS durationMinutes, price,
           booking_date AS bookingDate, source
    FROM bookings
    WHERE booking_date = ?
    ORDER BY unit, start_time
  `).all(date);
}

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/availability', (req, res) => {
  const availability = Object.fromEntries(Object.keys(UNITS).map(unit => [unit, []]));
  for (const booking of getTodayBookings()) availability[booking.unit].push(booking);
  res.json({ date: manilaDate(), bookings: availability });
});

app.post('/api/bookings', (req, res) => {
  const { unit, category, start, end, customer, contact } = req.body || {};
  if (!isValidUnit(unit) || UNITS[unit] !== category) {
    return res.status(400).json({ error: 'Choose a valid unit and category.' });
  }
  if (!isValidTime(start) || !isValidTime(end) || minutes(end) <= minutes(start)) {
    return res.status(400).json({ error: 'Enter a valid time range with an end after the start.' });
  }
  if (typeof customer !== 'string' || !customer.trim() || customer.trim().length > 100) {
    return res.status(400).json({ error: 'Enter a valid customer name.' });
  }
  if (typeof contact !== 'string' || !contact.trim() || contact.trim().length > 40) {
    return res.status(400).json({ error: 'Enter a valid contact number.' });
  }

  const date = manilaDate();
  ensureDefaultBlocksForDate(date);
  const durationMinutes = minutes(end) - minutes(start);
  const price = durationMinutes * (category === 'Deluxe' ? 5 : 1);
  try {
    const insertBooking = db.transaction(() => {
      const conflict = findConflict(unit, start, end, date);
      if (conflict) return { conflict };
      const result = db.prepare(`
        INSERT INTO bookings
          (unit, customer, contact, category, start_time, end_time,
           duration_minutes, price, booking_date, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'customer')
      `).run(unit, customer.trim(), contact.trim(), category, start, end, durationMinutes, price, date);
      return { id: Number(result.lastInsertRowid) };
    })();

    if (insertBooking.conflict) {
      return res.status(409).json({
        error: `Not available: ${unit} is already booked from ${insertBooking.conflict.start} to ${insertBooking.conflict.end}.`
      });
    }
    res.status(201).json({
      booking: {
        id: insertBooking.id,
        unit,
        customer: customer.trim(),
        contact: contact.trim(),
        category,
        start,
        end,
        durationMinutes,
        price,
        bookingDate: date
      }
    });
  } catch (error) {
    console.error('Unable to create booking:', error);
    res.status(500).json({ error: 'Unable to save the booking. Please try again.' });
  }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' }
});

app.post('/api/admin/login', loginLimiter, (req, res, next) => {
  const password = req.body && req.body.password;
  if (typeof password !== 'string' || password.length > 200) {
    return res.status(400).json({ error: 'Enter the admin password.' });
  }
  const submittedHash = crypto.scryptSync(password, passwordSalt, 64);
  if (!crypto.timingSafeEqual(configuredPasswordHash, submittedHash)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  req.session.regenerate(error => {
    if (error) return next(error);
    req.session.isAdmin = true;
    res.json({ authenticated: true });
  });
});

app.get('/api/admin/session', (req, res) => {
  res.json({ authenticated: Boolean(req.session.isAdmin) });
});

app.post('/api/admin/logout', requireAdmin, (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('lodge.admin', {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production'
    });
    res.json({ authenticated: false });
  });
});

app.get('/api/admin/bookings', requireAdmin, (req, res) => {
  res.json({ date: manilaDate(), bookings: getTodayBookings() });
});

app.get('/api/admin/records', requireAdmin, (req, res) => {
  const records = db.prepare(`
    SELECT id, unit, customer, contact, category,
           start_time AS start, end_time AS end,
           duration_minutes AS durationMinutes, price,
           booking_date AS bookingDate
    FROM bookings
    WHERE source = 'customer'
    ORDER BY booking_date DESC, start_time
  `).all();
  res.json({ records });
});

app.post('/api/admin/blocks', requireAdmin, (req, res) => {
  const { unit, start, end } = req.body || {};
  if (!isValidUnit(unit)) return res.status(400).json({ error: 'Choose a valid unit.' });
  if (!isValidTime(start) || !isValidTime(end) || minutes(end) <= minutes(start)) {
    return res.status(400).json({ error: 'Enter a valid time range with an end after the start.' });
  }
  const date = manilaDate();
  ensureDefaultBlocksForDate(date);
  const insertBlock = db.transaction(() => {
    const conflict = findConflict(unit, start, end, date);
    if (conflict) return false;
    db.prepare(`
      INSERT INTO bookings
        (unit, category, start_time, end_time, duration_minutes, price, booking_date, source)
      VALUES (?, ?, ?, ?, ?, 0, ?, 'admin')
    `).run(unit, UNITS[unit], start, end, minutes(end) - minutes(start), date);
    return true;
  });
  if (!insertBlock()) return res.status(409).json({ error: 'That time overlaps an existing booking.' });
  res.status(201).json({ success: true });
});

app.delete('/api/admin/units/:unit/bookings', requireAdmin, (req, res) => {
  if (!isValidUnit(req.params.unit)) return res.status(400).json({ error: 'Choose a valid unit.' });
  db.prepare('DELETE FROM bookings WHERE unit = ? AND booking_date = ?').run(req.params.unit, manilaDate());
  res.json({ success: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));

const sendStatic = express.static(ROOT, {
  dotfiles: 'deny',
  etag: true,
  index: 'index.html',
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
});
app.use((req, res, next) => {
  if (req.path === '/server.js' || (req.path !== '/' && !/\.(?:html|js|css|png|jpe?g|webp|svg|ico)$/i.test(req.path))) {
    return res.status(404).send('Not found.');
  }
  sendStatic(req, res, next);
});

app.use((error, req, res, next) => {
  console.error('Request failed:', error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

app.listen(PORT, () => {
  console.log(`Whispering Pines booking app listening on port ${PORT}`);
});
