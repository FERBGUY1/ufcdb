const express = require('express');
const router = express.Router();
const supabase = require('../db/client');

// GET /api/fighters
// Query params: weight_class, status, search, page, limit, sort
router.get('/', async (req, res, next) => {
  try {
    const {
      weight_class,
      status = 'all',
      search,
      page = 1,
      limit: limitParam = 50,
      sort = 'last_name',
      order = 'asc',
      champion,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limitParam)));
    const offset = (pageNum - 1) * limitNum;

    let query = supabase
      .from('fighters')
      .select(`
        id, slug, first_name, last_name, nickname, status,
        is_champion, is_interim_champ, rank,
        wins, losses, draws, no_contests,
        height_inches, reach_inches, stance,
        nationality, gym_name, head_coach,
        photo_url, instagram,
        primary_weight_class_id,
        weight_classes ( name, slug )
      `, { count: 'exact' });

    // Filters
    if (weight_class) {
      // Look up weight class ID by slug for reliable filtering
      const { data: wc } = await supabase.from('weight_classes').select('id').eq('slug', weight_class).single();
      if (wc) query = query.eq('primary_weight_class_id', wc.id);
    }
    if (status !== 'all') {
      query = query.eq('status', status);
    }
    if (champion === 'true') {
      query = query.eq('is_champion', true);
    }
    if (search) {
      const parts = search.trim().split(/\s+/);
      if (parts.length >= 2) {
        const first = parts[0];
        const last  = parts.slice(1).join(' ');
        query = query.or(
          `and(first_name.ilike.%${first}%,last_name.ilike.%${last}%),` +
          `and(first_name.ilike.%${last}%,last_name.ilike.%${first}%),` +
          `nickname.ilike.%${search}%`
        );
      } else {
        query = query.or(
          `first_name.ilike.%${search}%,last_name.ilike.%${search}%,nickname.ilike.%${search}%`
        );
      }
    }

    // Sort
    const validSorts = ['last_name', 'first_name', 'wins', 'rank', 'updated_at'];
    const sortField = validSorts.includes(sort) ? sort : 'last_name';
    query = query.order(sortField, { ascending: order !== 'desc' });

    // Pagination
    query = query.range(offset, offset + limitNum - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      fighters: data || [],
      pagination: {
        total: count || 0,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil((count || 0) / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/fighters/:slug
// Full fighter profile
router.get('/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params;

    const { data: fighter, error } = await supabase
      .from('fighters')
      .select(`
        *,
        weight_classes ( id, name, slug ),
        gyms ( id, name, city, country, head_coach )
      `)
      .eq('slug', slug)
      .single();

    if (error || !fighter) {
      return res.status(404).json({ error: 'Fighter not found' });
    }

    // Get fight history with event info and odds
    const { data: fights } = await supabase
      .from('fights')
      .select(`
        id, result, method, method_detail, round, time,
        is_title_fight, fighter1_record_at_fight, fighter2_record_at_fight,
        fighter1_sig_str, fighter2_sig_str, fighter1_td, fighter2_td,
        card_position,
        events ( id, name, slug, date, city, country ),
        fighter1:fighters!fighter1_id ( id, slug, first_name, last_name, nickname, photo_url ),
        fighter2:fighters!fighter2_id ( id, slug, first_name, last_name, nickname, photo_url ),
        winner:fighters!winner_id ( id, slug, first_name, last_name ),
        odds ( bookmaker, fighter1_odds, fighter2_odds, line_type, recorded_at )
      `)
      .or(`fighter1_id.eq.${fighter.id},fighter2_id.eq.${fighter.id}`)
      .order('events(date)', { ascending: false })
      .limit(200);

    // The DB ordering by events(date) is authoritative. This JS sort is a
    // belt-and-suspenders fallback for fights with no linked event (null date).
    const sortedFights = (fights || []).sort((a, b) => {
      const da = a.events?.date ?? '';
      const db = b.events?.date ?? '';
      if (db > da) return 1;
      if (db < da) return -1;
      return 0;
    });

    // Get current rankings
    const { data: rankings } = await supabase
      .from('rankings')
      .select('rank, is_interim, weight_classes(name, slug)')
      .eq('fighter_id', fighter.id)
      .order('recorded_date', { ascending: false })
      .limit(5);

    res.json({
      fighter,
      fights: sortedFights,
      rankings: rankings || [],
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/fighters/:slug/odds-history
router.get('/:slug/odds-history', async (req, res, next) => {
  try {
    const { slug } = req.params;

    const { data: fighter } = await supabase
      .from('fighters')
      .select('id')
      .eq('slug', slug)
      .single();

    if (!fighter) return res.status(404).json({ error: 'Fighter not found' });

    const { data: oddsHistory } = await supabase
      .from('fights')
      .select(`
        id, result, method, round,
        events ( name, date ),
        fighter1:fighters!fighter1_id ( id, first_name, last_name ),
        fighter2:fighters!fighter2_id ( id, first_name, last_name ),
        odds ( bookmaker, fighter1_odds, fighter2_odds, line_type, recorded_at )
      `)
      .or(`fighter1_id.eq.${fighter.id},fighter2_id.eq.${fighter.id}`)
      .order('date', { referencedTable: 'events', ascending: false })
      .limit(30);

    // Calculate ATS record (against the spread)
    let favRecord = { wins: 0, losses: 0 };
    let dogRecord = { wins: 0, losses: 0 };

    for (const fight of oddsHistory || []) {
      const openOdds = fight.odds?.find(o => o.line_type === 'opening');
      if (!openOdds) continue;

      const isFighter1 = fight.fighter1?.id === fighter.id;
      const myOdds = isFighter1 ? openOdds.fighter1_odds : openOdds.fighter2_odds;
      const won = fight.winner_id === fighter.id;

      if (myOdds < 0) {
        if (won) favRecord.wins++; else favRecord.losses++;
      } else {
        if (won) dogRecord.wins++; else dogRecord.losses++;
      }
    }

    res.json({
      odds_history: oddsHistory || [],
      ats_record: {
        as_favorite: favRecord,
        as_underdog: dogRecord,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/fighters/:slug/compare?opponent=<slug>
router.get('/:slug/compare', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const { opponent } = req.query;

    if (!opponent) return res.status(400).json({ error: 'opponent slug required' });

    const [{ data: f1 }, { data: f2 }] = await Promise.all([
      supabase.from('fighters').select('*').eq('slug', slug).single(),
      supabase.from('fighters').select('*').eq('slug', opponent).single(),
    ]);

    if (!f1 || !f2) return res.status(404).json({ error: 'One or both fighters not found' });

    // Check if they have fought before
    const { data: history } = await supabase
      .from('fights')
      .select(`
        result, method, round, time,
        events ( name, date ),
        winner:fighters!winner_id ( id, first_name, last_name )
      `)
      .or(`and(fighter1_id.eq.${f1.id},fighter2_id.eq.${f2.id}),and(fighter1_id.eq.${f2.id},fighter2_id.eq.${f1.id})`)
      .order('events.date', { ascending: false });

    res.json({
      fighter1: f1,
      fighter2: f2,
      head_to_head: history || [],
      stat_comparison: buildStatComparison(f1, f2),
    });
  } catch (err) {
    next(err);
  }
});

function buildStatComparison(f1, f2) {
  const stats = [
    { key: 'slpm',    label: 'Strikes Landed/Min',   higher_is_better: true },
    { key: 'sapm',    label: 'Strikes Absorbed/Min',  higher_is_better: false },
    { key: 'str_acc', label: 'Striking Accuracy',     higher_is_better: true,  is_percent: true },
    { key: 'str_def', label: 'Striking Defense',      higher_is_better: true,  is_percent: true },
    { key: 'td_avg',  label: 'Takedowns/15 Min',      higher_is_better: true },
    { key: 'td_acc',  label: 'Takedown Accuracy',     higher_is_better: true,  is_percent: true },
    { key: 'td_def',  label: 'Takedown Defense',      higher_is_better: true,  is_percent: true },
    { key: 'sub_avg', label: 'Submission Attempts',   higher_is_better: true },
  ];

  return stats.map(stat => ({
    ...stat,
    fighter1_value: f1[stat.key],
    fighter2_value: f2[stat.key],
    advantage: f1[stat.key] == null || f2[stat.key] == null
      ? null
      : stat.higher_is_better
        ? (f1[stat.key] > f2[stat.key] ? 'fighter1' : f2[stat.key] > f1[stat.key] ? 'fighter2' : 'even')
        : (f1[stat.key] < f2[stat.key] ? 'fighter1' : f2[stat.key] < f1[stat.key] ? 'fighter2' : 'even'),
  }));
}

// PATCH /api/fighters/:slug — update personal/scouting data (admin only for now)
router.patch('/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const allowedFields = [
      'nickname', 'relationship_status', 'partner_name', 'children_count',
      'children_notes', 'military_service', 'education', 'religion',
      'head_coach', 'notable_coaches', 'training_partners', 'gym_name',
      'instagram', 'twitter', 'youtube', 'tiktok',
      'strengths', 'weaknesses', 'fighting_style', 'scout_notes',
      'photo_url',
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data, error } = await supabase
      .from('fighters')
      .update(updates)
      .eq('slug', slug)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Fighter not found' });

    res.json({ fighter: data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
