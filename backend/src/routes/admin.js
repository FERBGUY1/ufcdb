// ── admin.js ─────────────────────────────────────────────
// Simple admin endpoints — add proper auth middleware before deploying
const express = require('express');
const router = express.Router();
const supabase = require('../db/client');

// Basic API key check — replace with proper auth in production
const adminAuth = (req, res, next) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

router.use(adminAuth);

// GET /api/admin/flags — view data quality flags from users
router.get('/flags', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('data_flags')
      .select('*')
      .eq('status', 'open')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ flags: data || [] });
  } catch (err) { next(err); }
});

// POST /api/admin/fighters/:id/photo — update fighter photo
router.post('/fighters/:id/photo', async (req, res, next) => {
  try {
    const { photo_url } = req.body;
    const { data, error } = await supabase
      .from('fighters')
      .update({ photo_url })
      .eq('id', req.params.id)
      .select('id, slug, first_name, last_name, photo_url')
      .single();

    if (error) throw error;
    res.json({ fighter: data });
  } catch (err) { next(err); }
});

// POST /api/admin/scrapers/run — manually trigger a scraper
router.post('/scrapers/run', async (req, res, next) => {
  try {
    const { scraper } = req.body;
    const valid = ['odds'];
    if (!valid.includes(scraper)) {
      return res.status(400).json({ error: 'Invalid scraper. Valid: ' + valid.join(', ') });
    }
    if (scraper === 'odds') {
      const { syncOdds } = require('../scrapers/odds');
      const result = await syncOdds();
      return res.json({ success: true, ...result });
    }
  } catch (err) { next(err); }
});

module.exports = router;
