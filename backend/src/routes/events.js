// ── events.js ────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const supabase = require('../db/client');

router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit: lim = 20, upcoming, year } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, parseInt(lim));
    const offset = (pageNum - 1) * limitNum;

    let query = supabase
      .from('events')
      .select('*', { count: 'exact' });

    if (upcoming === 'true') {
      query = query.gte('date', new Date().toISOString().split('T')[0]).eq('is_complete', false);
    } else if (upcoming === 'false') {
      query = query.lt('date', new Date().toISOString().split('T')[0]);
    }

    if (year) {
      query = query.gte('date', `${year}-01-01`).lt('date', `${parseInt(year)+1}-01-01`);
    }

    query = query.order('date', { ascending: upcoming === 'true' }).range(offset, offset + limitNum - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ events: data || [], pagination: { total: count, page: pageNum, limit: limitNum } });
  } catch (err) { next(err); }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const { data: event, error } = await supabase
      .from('events')
      .select('*')
      .eq('slug', req.params.slug)
      .single();

    if (error || !event) return res.status(404).json({ error: 'Event not found' });

    const { data: fights } = await supabase
      .from('fights')
      .select(`
        id, result, method, round, time, card_position, is_title_fight,
        fighter1_record_at_fight, fighter2_record_at_fight,
        fighter1:fighters!fighter1_id ( id, slug, first_name, last_name, nickname, photo_url ),
        fighter2:fighters!fighter2_id ( id, slug, first_name, last_name, nickname, photo_url ),
        winner:fighters!winner_id ( id, first_name, last_name ),
        odds ( bookmaker, fighter1_odds, fighter2_odds, line_type, recorded_at )
      `)
      .eq('event_id', event.id)
      .order('bout_order');

    res.json({ event, fights: fights || [] });
  } catch (err) { next(err); }
});

module.exports = router;
