// ── odds.js ──────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const supabase = require('../db/client');
const { syncOdds, getConsensusOdds } = require('../scrapers/odds');

// GET /api/odds/upcoming — all current odds for upcoming fights
router.get('/upcoming', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('fights')
      .select(`
        id, is_title_fight,
        events ( name, slug, date ),
        fighter1:fighters!fighter1_id ( id, slug, first_name, last_name, photo_url ),
        fighter2:fighters!fighter2_id ( id, slug, first_name, last_name, photo_url ),
        odds ( bookmaker, fighter1_odds, fighter2_odds, line_type, recorded_at )
      `)
      .eq('result', 'upcoming')
      .order('events.date', { ascending: true })
      .limit(30);

    if (error) throw error;
    res.json({ fights: data || [] });
  } catch (err) { next(err); }
});

// GET /api/odds/:fightId/consensus
router.get('/:fightId/consensus', async (req, res, next) => {
  try {
    const consensus = await getConsensusOdds(req.params.fightId);
    if (!consensus) return res.status(404).json({ error: 'No odds found' });
    res.json(consensus);
  } catch (err) { next(err); }
});

// POST /api/odds/sync (manual trigger, admin)
router.post('/sync', async (req, res, next) => {
  try {
    const result = await syncOdds();
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

module.exports = router;
