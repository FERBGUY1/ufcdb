const express  = require('express');
const router   = express.Router();
const supabase = require('../db/client');

router.get('/:id', async (req, res, next) => {
  try {
    const { data: fight, error } = await supabase
      .from('fights')
      .select(`
        id, result, method, method_detail, round, time, is_title_fight,
        fighter1_record_at_fight, fighter2_record_at_fight,
        fighter1_sig_str, fighter2_sig_str, fighter1_td, fighter2_td,
        fighter1_style_at_fight, fighter2_style_at_fight,
        fighter1:fighters!fighter1_id ( id, slug, first_name, last_name, nickname, photo_url, primary_style ),
        fighter2:fighters!fighter2_id ( id, slug, first_name, last_name, nickname, photo_url, primary_style ),
        events ( id, slug, name, date, city, country ),
        odds ( bookmaker, fighter1_odds, fighter2_odds, line_type, recorded_at )
      `)
      .eq('id', req.params.id)
      .single();

    if (error || !fight) return res.status(404).json({ error: 'Fight not found' });
    res.json({ fight });
  } catch (err) { next(err); }
});

module.exports = router;
