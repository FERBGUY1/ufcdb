// â”€â”€ search.js â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const express = require('express');
const router = express.Router();
const supabase = require('../db/client');

// GET /api/search?q=jon+jones
router.get('/', async (req, res, next) => {
  try {
    const { q, limit: lim = 20 } = req.query;
    if (!q || q.length < 2) return res.json({ fighters: [], events: [] });

    const limitNum = Math.min(20, parseInt(lim));

    // Build fighter filter â€” handle "Jon Jones" (multi-word) and "Jones" (single) separately
    const parts = q.trim().split(/\s+/);
    let fighterQ = supabase
      .from('fighters')
      .select('id, slug, first_name, last_name, nickname, status, wins, losses, draws, no_contests, pro_wins, pro_losses, pro_draws, pro_nc, photo_url, weight_classes(name)');

    if (parts.length >= 2) {
      const first = parts[0];
      const last  = parts.slice(1).join(' ');
      // Match first+last in order, OR last+first (reversed), OR nickname contains full query
      fighterQ = fighterQ.or(
        `and(first_name.ilike.%${first}%,last_name.ilike.%${last}%),` +
        `and(first_name.ilike.%${last}%,last_name.ilike.%${first}%),` +
        `nickname.ilike.%${q}%`
      );
    } else {
      fighterQ = fighterQ.or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,nickname.ilike.%${q}%`);
    }

    const [{ data: fighters }, { data: events }] = await Promise.all([
      fighterQ
        .order('is_champion', { ascending: false })
        .order('wins', { ascending: false })
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


