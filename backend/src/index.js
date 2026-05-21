require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const rateLimit = require('express-rate-limit');
const cron    = require('node-cron');

const fightersRouter    = require('./routes/fighters');
const eventsRouter      = require('./routes/events');
const oddsRouter        = require('./routes/odds');
const searchRouter      = require('./routes/search');
const statsRouter       = require('./routes/stats');
const predictRouter     = require('./routes/predict');
const styleRouter       = require('./routes/styles');
const adminRouter       = require('./routes/admin');

const { syncOdds }             = require('./scrapers/odds');
const { computeStyleMatchups } = require('./ml/qualityEngine');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173', credentials: true }));
app.use(morgan('dev'));
app.use(express.json());

const limiter = rateLimit({ windowMs: 60*1000, max: 300, standardHeaders: true });
app.use('/api/', limiter);

// Stricter limit on prediction endpoint (it calls AI)
const predictLimiter = rateLimit({ windowMs: 60*1000, max: 10 });
app.use('/api/predict', predictLimiter);

app.use('/api/fighters', fightersRouter);
app.use('/api/events',   eventsRouter);
app.use('/api/odds',     oddsRouter);
app.use('/api/search',   searchRouter);
app.use('/api/stats',    statsRouter);
app.use('/api/predict',  predictRouter);
app.use('/api/styles',   styleRouter);
app.use('/api/admin',    adminRouter);

app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// Sync odds every 2 hours
cron.schedule('0 */2 * * *', async () => {
  try { await syncOdds(); } catch(e) { console.error('[CRON] Odds sync failed:', e.message); }
});

// Recompute style matchups weekly (Sunday 3am)
cron.schedule('0 3 * * 0', async () => {
  try { await computeStyleMatchups(); } catch(e) { console.error('[CRON] Style compute failed:', e.message); }
});

app.listen(PORT, () => {
  console.log(`\n🥊 UFCDB v2 Backend — port ${PORT}`);
  console.log(`   http://localhost:${PORT}/api/health\n`);
});
