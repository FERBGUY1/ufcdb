const express = require('express');
const router = express.Router();
const supabase = require('../db/client');

// GET /api/rankings?weight_class=lightweight
// Returns champion + top 15 for a weight class using the latest recorded rankings
router.get('/', async (req, res, next) => {
  try {
    const { weight_class } = req.query;

    // Get weight class id if slug provided
    let wcId = null;
    if (weight_class) {
      const { data: wc } = await supabase.from('weight_classes').select('id').eq('slug', weight_class).single();
      if (!wc) return res.status(404).json({ error: 'Weight class not found' });
      wcId = wc.id;
    }

    // Get the most recent recorded_date for this weight class
    let dateQuery = supabase.from('rankings').select('recorded_date').order('recorded_date', { ascending: false }).limit(1);
    if (wcId) dateQuery = dateQuery.eq('weight_class_id', wcId);
    const { data: dateRow } = await dateQuery.single();

    if (!dateRow) return res.json({ rankings: [], recorded_date: null });
    const latestDate = dateRow.recorded_date;

    // Fetch rankings for that date
    let rankQuery = supabase
      .from('rankings')
      .select(`
        rank, is_interim, recorded_date,
        weight_classes ( id, name, slug ),
        fighters!fighter_id (
          id, slug, first_name, last_name, nickname,
          wins, losses, draws, no_contests,
          pro_wins, pro_losses, pro_draws, pro_nc,
          is_champion, photo_url, status,
          primary_weight_class_id
        )
      `)
      .eq('recorded_date', latestDate)
      .order('rank', { ascending: true });

    if (wcId) rankQuery = rankQuery.eq('weight_class_id', wcId);

    const { data: rankings, error } = await rankQuery;
    if (error) throw error;

    res.json({ rankings: rankings || [], recorded_date: latestDate });
  } catch (err) { next(err); }
});

// GET /api/rankings/all — all divisions' rankings in one call
router.get('/all', async (req, res, next) => {
  try {
    // Get most recent date
    const { data: dateRow } = await supabase
      .from('rankings')
      .select('recorded_date')
      .order('recorded_date', { ascending: false })
      .limit(1)
      .single();

    if (!dateRow) return res.json({ divisions: [], recorded_date: null });
    const latestDate = dateRow.recorded_date;

    const { data: rankings, error } = await supabase
      .from('rankings')
      .select(`
        rank, is_interim, recorded_date,
        weight_classes ( id, name, slug, sort_order ),
        fighters!fighter_id (
          id, slug, first_name, last_name, nickname,
          wins, losses, draws, no_contests,
          pro_wins, pro_losses, pro_draws, pro_nc,
          is_champion, photo_url, status
        )
      `)
      .eq('recorded_date', latestDate)
      .order('rank', { ascending: true });

    if (error) throw error;

    // Group by weight class
    const divMap = {};
    for (const r of rankings || []) {
      const wc = r.weight_classes;
      if (!wc) continue;
      if (!divMap[wc.slug]) {
        divMap[wc.slug] = {
          weight_class: wc,
          champion: null,
          ranked: [],
        };
      }
      if (r.rank === 0) {
        divMap[wc.slug].champion = r.fighters;
      } else {
        divMap[wc.slug].ranked.push({ rank: r.rank, is_interim: r.is_interim, fighter: r.fighters });
      }
    }

    // Sort divisions by sort_order
    const divisions = Object.values(divMap).sort((a, b) =>
      (a.weight_class.sort_order ?? 99) - (b.weight_class.sort_order ?? 99)
    );

    res.json({ divisions, recorded_date: latestDate });
  } catch (err) { next(err); }
});

module.exports = router;
