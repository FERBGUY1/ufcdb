// ── search.js ────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const supabase = require('../db/client');

// GET /api/search?q=jon+jones
router.get('/', async (req, res, next) => {
  try {
    const { q, limit: lim = 10 } = req.query;
    if (!q || q.length < 2) return res.json({ fighters: [], events: [] });

    const limitNum = Math.min(20, parseInt(lim));

    const [{ data: fighters }, { data: events }] = await Promise.all([
      supabase
        .from('fighters')
        .select('id, slug, first_name, last_name, nickname, status, wins, losses, draws, photo_url, weight_classes(name)')
        .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,nickname.ilike.%${q}%`)
        .limit(limitNum),

      supabase
        .from('events')
        .select('id, slug, name, date, city, country')
        .ilike('name', `%${q}%`)
        .limit(5),
    ]);

    res.json({
      fighters: fighters || [],
      events: events || [],
      query: q,
    });
  } catch (err) { next(err); }
});

module.exports = router;
