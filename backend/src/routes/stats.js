// ── stats.js ─────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const supabase = require('../db/client');

// GET /api/stats/overview — site-wide counts for the homepage
router.get('/overview', async (req, res, next) => {
  try {
    const [fighters, events, fights, odds, active] = await Promise.all([
      supabase.from('fighters').select('id', { count: 'exact', head: true }),
      supabase.from('events').select('id', { count: 'exact', head: true }),
      supabase.from('fights').select('id', { count: 'exact', head: true }),
      supabase.from('odds').select('id', { count: 'exact', head: true }),
      supabase.from('fighters').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    ]);

    res.json({
      total_fighters:  fighters.count ?? 0,
      active_fighters: active.count   ?? 0,
      total_events:    events.count   ?? 0,
      total_fights:    fights.count   ?? 0,
      total_odds:      odds.count     ?? 0,
    });
  } catch (err) { next(err); }
});

module.exports = router;
