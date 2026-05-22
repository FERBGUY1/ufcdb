// â”€â”€ events.js â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const express = require('express');
const router = express.Router();
const supabase = require('../db/client');

router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit: lim = 20, upcoming, year, search } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, parseInt(lim));
    const offset = (pageNum - 1) * limitNum;

    let query = supabase
      .from('events')
      .select('*', { count: 'exact' });

    // Use is_complete flag rather than date comparison so events with null
    // dates (e.g. very early events whose date failed to parse) still appear
    if (upcoming === 'true') {
      query = query.eq('is_complete', false);
    } else if (upcoming === 'false') {
      query = query.eq('is_complete', true);
    }

    if (year) {
      query = query.gte('date', `${year}-01-01`).lte('date', `${year}-12-31`);
    }

    if (search) {
      query = query.ilike('name', `%${search}%`);
    }
    query = query.order('date', { ascending: upcoming === 'true', nullsFirst: false }).range(offset, offset + limitNum - 1);

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
        id, bout_order, result, method, method_detail, round, time, card_position, is_title_fight,
        fighter1_record_at_fight, fighter2_record_at_fight,
        fighter1:fighters!fighter1_id ( id, slug, first_name, last_name, nickname, photo_url ),
        fighter2:fighters!fighter2_id ( id, slug, first_name, last_name, nickname, photo_url ),
        winner:fighters!winner_id ( id, first_name, last_name ),
        odds ( bookmaker, fighter1_odds, fighter2_odds, line_type, recorded_at )
      `)
      .eq('event_id', event.id)
      .order('bout_order', { ascending: true, nullsFirst: false });

    // Sort by card section then bout position.
    // card_position ('main_card'/'prelim'/'early_prelim') is populated for new events;
    // historical fights have it NULL so fall back to bout_order (0 = main event,
    // corrected by fix-bout-order.js for all events where the headliner was late-added).
    const sectionRank = { main_card: 0, prelim: 1, early_prelim: 2 };
    const sortedFights = (fights || []).sort((a, b) => {
      const posA = a.card_position != null ? (sectionRank[a.card_position] ?? 0) : null;
      const posB = b.card_position != null ? (sectionRank[b.card_position] ?? 0) : null;
      if (posA !== null && posB !== null && posA !== posB) return posA - posB;
      if (posA !== null && posB === null) return -1;
      if (posA === null && posB !== null) return 1;
      return (a.bout_order ?? 999) - (b.bout_order ?? 999);
    });

    res.json({ event, fights: sortedFights });
  } catch (err) { next(err); }
});

module.exports = router;

